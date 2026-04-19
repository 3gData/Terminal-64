#![allow(dead_code)]

use fastembed::{EmbeddingModel, InitOptions, TextEmbedding};
use rusqlite::{params, Connection};
use std::path::PathBuf;

/// Tables that the vector store manages.
pub const TABLES: &[&str] = &[
    "vec_sessions",
    "vec_skills",
    "vec_widgets",
    "vec_files",
    "vec_errors",
];

/// A single search result returned from a KNN query.
#[derive(Debug, Clone, serde::Serialize)]
pub struct VectorSearchResult {
    pub id: String,
    pub distance: f64,
    pub table: String,
    pub title: String,
    pub source: String,
    pub content_preview: String,
}

/// Serialize a `&[f32]` slice into a little-endian byte blob.
fn f32_to_blob(v: &[f32]) -> Vec<u8> {
    v.iter().flat_map(|f| f.to_le_bytes()).collect()
}

/// Deserialize a little-endian byte blob back into `Vec<f32>`.
fn blob_to_f32(blob: &[u8]) -> Vec<f32> {
    blob.chunks_exact(4)
        .map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]]))
        .collect()
}

/// Cosine similarity between two vectors. Returns 1.0 - similarity so lower = more similar.
fn cosine_distance(a: &[f32], b: &[f32]) -> f64 {
    let mut dot = 0.0f64;
    let mut norm_a = 0.0f64;
    let mut norm_b = 0.0f64;
    for (x, y) in a.iter().zip(b.iter()) {
        let x = *x as f64;
        let y = *y as f64;
        dot += x * y;
        norm_a += x * x;
        norm_b += y * y;
    }
    let denom = norm_a.sqrt() * norm_b.sqrt();
    if denom == 0.0 {
        return 1.0;
    }
    1.0 - (dot / denom)
}

/// Local vector store backed by rusqlite + fastembed.
///
/// Uses regular SQLite tables with BLOB columns for embeddings and performs
/// cosine similarity search in Rust. This avoids the sqlite-vec extension
/// (which has packaging issues in its alpha release).
pub struct VectorStore {
    db: Connection,
    model: TextEmbedding,
}

impl VectorStore {
    /// Open (or create) the vector store database and initialize the embedding model.
    /// The DB lives at `~/.terminal64/vector_store.db`.
    pub fn initialize() -> Result<Self, String> {
        let db_path = Self::db_path()?;

        // Ensure parent dir exists
        if let Some(parent) = db_path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("Failed to create vector store dir: {e}"))?;
        }

        let db = Connection::open(&db_path)
            .map_err(|e| format!("Failed to open vector store DB: {e}"))?;

        // Performance pragmas
        db.execute_batch(
            "PRAGMA journal_mode=WAL;
             PRAGMA synchronous=NORMAL;
             PRAGMA cache_size=-8000;",
        )
        .map_err(|e| format!("Pragma setup failed: {e}"))?;

        Self::create_tables(&db)?;

        // Set up the fastembed cache inside ~/.terminal64/ so it doesn't pollute cwd
        let cache_dir = Self::base_dir()?.join("fastembed_cache");
        std::fs::create_dir_all(&cache_dir)
            .map_err(|e| format!("Failed to create fastembed cache dir: {e}"))?;

        let model = TextEmbedding::try_new(
            InitOptions::new(EmbeddingModel::BGESmallENV15)
                .with_cache_dir(cache_dir)
                .with_show_download_progress(false),
        )
        .map_err(|e| format!("Failed to init embedding model: {e}"))?;

        Ok(Self { db, model })
    }

    fn base_dir() -> Result<PathBuf, String> {
        let home = dirs::home_dir().ok_or("No home directory")?;
        Ok(home.join(".terminal64"))
    }

    fn db_path() -> Result<PathBuf, String> {
        Ok(Self::base_dir()?.join("vector_store.db"))
    }

    /// Create all tables if they don't already exist.
    /// Each table has the same schema: id, embedding blob, title, source, content_preview.
    fn create_tables(db: &Connection) -> Result<(), String> {
        for table in TABLES {
            db.execute_batch(&format!(
                "CREATE TABLE IF NOT EXISTS {table} (
                    item_id   TEXT PRIMARY KEY,
                    embedding BLOB NOT NULL,
                    title     TEXT NOT NULL DEFAULT '',
                    source    TEXT NOT NULL DEFAULT '',
                    content_preview TEXT NOT NULL DEFAULT '',
                    updated_at INTEGER NOT NULL DEFAULT (unixepoch())
                );"
            ))
            .map_err(|e| format!("Failed to create table {table}: {e}"))?;
        }
        Ok(())
    }

    /// Embed a single text string. Returns the f32 vector.
    pub fn embed_text(&mut self, text: &str) -> Result<Vec<f32>, String> {
        let results = self
            .model
            .embed(vec![text], None)
            .map_err(|e| format!("Embedding failed: {e}"))?;
        results
            .into_iter()
            .next()
            .ok_or_else(|| "Embedding returned empty result".to_string())
    }

    /// Upsert a record into the specified table.
    pub fn upsert(
        &mut self,
        table: &str,
        id: &str,
        text: &str,
        title: &str,
        source: &str,
        content_preview: &str,
    ) -> Result<(), String> {
        Self::validate_table(table)?;
        let embedding = self.embed_text(text)?;
        let blob = f32_to_blob(&embedding);

        self.db
            .execute(
                &format!(
                    "INSERT INTO {table}(item_id, embedding, title, source, content_preview, updated_at)
                     VALUES (?1, ?2, ?3, ?4, ?5, unixepoch())
                     ON CONFLICT(item_id) DO UPDATE SET
                       embedding = excluded.embedding,
                       title = excluded.title,
                       source = excluded.source,
                       content_preview = excluded.content_preview,
                       updated_at = unixepoch()"
                ),
                params![id, blob, title, source, content_preview],
            )
            .map_err(|e| format!("Upsert failed: {e}"))?;

        Ok(())
    }

    // ---- Typed upsert helpers ----

    pub fn upsert_session(
        &mut self,
        id: &str,
        text: &str,
        title: &str,
        source: &str,
        preview: &str,
    ) -> Result<(), String> {
        self.upsert("vec_sessions", id, text, title, source, preview)
    }

    pub fn upsert_skill(
        &mut self,
        id: &str,
        text: &str,
        title: &str,
        source: &str,
        preview: &str,
    ) -> Result<(), String> {
        self.upsert("vec_skills", id, text, title, source, preview)
    }

    pub fn upsert_widget(
        &mut self,
        id: &str,
        text: &str,
        title: &str,
        source: &str,
        preview: &str,
    ) -> Result<(), String> {
        self.upsert("vec_widgets", id, text, title, source, preview)
    }

    pub fn upsert_file(
        &mut self,
        id: &str,
        text: &str,
        title: &str,
        source: &str,
        preview: &str,
    ) -> Result<(), String> {
        self.upsert("vec_files", id, text, title, source, preview)
    }

    pub fn upsert_error(
        &mut self,
        id: &str,
        text: &str,
        title: &str,
        source: &str,
        preview: &str,
    ) -> Result<(), String> {
        self.upsert("vec_errors", id, text, title, source, preview)
    }

    /// KNN search across a single table. Returns top-k results ordered by cosine distance.
    ///
    /// Loads all embeddings from the table and computes cosine distance in Rust.
    /// This is efficient for the expected dataset sizes (hundreds to low thousands of items).
    pub fn search(
        &mut self,
        table: &str,
        query: &str,
        top_k: usize,
    ) -> Result<Vec<VectorSearchResult>, String> {
        let query_embedding = self.embed_text(query)?;
        self.search_by_embedding(table, &query_embedding, top_k)
    }

    /// Search a single table using a pre-computed embedding vector.
    fn search_by_embedding(
        &self,
        table: &str,
        query_embedding: &[f32],
        top_k: usize,
    ) -> Result<Vec<VectorSearchResult>, String> {
        Self::validate_table(table)?;

        let mut stmt = self
            .db
            .prepare(&format!(
                "SELECT item_id, embedding, title, source, content_preview FROM {table}"
            ))
            .map_err(|e| format!("Search prepare failed: {e}"))?;

        let mut scored: Vec<VectorSearchResult> = stmt
            .query_map([], |row| {
                let id: String = row.get(0)?;
                let blob: Vec<u8> = row.get(1)?;
                let title: String = row.get(2)?;
                let source: String = row.get(3)?;
                let content_preview: String = row.get(4)?;
                Ok((id, blob, title, source, content_preview))
            })
            .map_err(|e| format!("Search query failed: {e}"))?
            .filter_map(|r| r.ok())
            .map(|(id, blob, title, source, content_preview)| {
                let embedding = blob_to_f32(&blob);
                let distance = cosine_distance(query_embedding, &embedding);
                VectorSearchResult {
                    id,
                    distance,
                    table: table.to_string(),
                    title,
                    source,
                    content_preview,
                }
            })
            .collect();

        scored.sort_by(|a, b| {
            a.distance
                .partial_cmp(&b.distance)
                .unwrap_or(std::cmp::Ordering::Equal)
        });
        scored.truncate(top_k);
        Ok(scored)
    }

    /// Search across all tables with a single embedding pass.
    pub fn search_all(
        &mut self,
        query: &str,
        top_k: usize,
    ) -> Result<Vec<VectorSearchResult>, String> {
        let query_embedding = self.embed_text(query)?;
        let mut all_results = Vec::new();
        for table in TABLES {
            match self.search_by_embedding(table, &query_embedding, top_k) {
                Ok(results) => all_results.extend(results),
                Err(_) => continue,
            }
        }
        all_results.sort_by(|a, b| {
            a.distance
                .partial_cmp(&b.distance)
                .unwrap_or(std::cmp::Ordering::Equal)
        });
        all_results.truncate(top_k);
        Ok(all_results)
    }

    /// Delete a record from a table by id.
    pub fn delete(&self, table: &str, id: &str) -> Result<(), String> {
        Self::validate_table(table)?;
        self.db
            .execute(
                &format!("DELETE FROM {table} WHERE item_id = ?1"),
                params![id],
            )
            .map_err(|e| format!("Delete failed: {e}"))?;
        Ok(())
    }

    /// Get the count of records in a table.
    pub fn count(&self, table: &str) -> Result<usize, String> {
        Self::validate_table(table)?;
        let count: i64 = self
            .db
            .query_row(&format!("SELECT count(*) FROM {table}"), [], |r| r.get(0))
            .map_err(|e| format!("Count failed: {e}"))?;
        Ok(count as usize)
    }

    /// Validate that the table name is one of the known tables (prevents SQL injection).
    fn validate_table(table: &str) -> Result<(), String> {
        if TABLES.contains(&table) {
            Ok(())
        } else {
            Err(format!(
                "Invalid table '{}'. Must be one of: {}",
                table,
                TABLES.join(", ")
            ))
        }
    }
}
