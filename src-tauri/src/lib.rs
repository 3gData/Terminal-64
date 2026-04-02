mod claude_manager;
mod discord_bot;
mod permission_server;
mod pty_manager;
mod types;

use claude_manager::ClaudeManager;
use discord_bot::DiscordBot;
use permission_server::PermissionServer;
use pty_manager::PtyManager;
use std::sync::{Arc, Mutex};
use tauri::{Emitter, Manager};
use types::*;

const SKIP_DIRS: &[&str] = &["node_modules", ".git", "target", "dist", ".next", "__pycache__", ".venv", "vendor"];

fn session_project_dir(cwd: &str) -> Result<std::path::PathBuf, String> {
    let home = dirs::home_dir().ok_or("No home dir")?;
    let dir_hash = cwd.replace(':', "-").replace('\\', "-").replace('/', "-");
    Ok(home.join(".claude").join("projects").join(dir_hash))
}

fn session_jsonl_path(cwd: &str, session_id: &str) -> Result<std::path::PathBuf, String> {
    Ok(session_project_dir(cwd)?.join(format!("{}.jsonl", session_id)))
}

struct AppState {
    pty_manager: PtyManager,
    claude_manager: Arc<ClaudeManager>,
    discord_bot: Mutex<DiscordBot>,
    permission_server: Arc<PermissionServer>,
}

#[tauri::command]
fn create_terminal(
    state: tauri::State<'_, AppState>,
    app_handle: tauri::AppHandle,
    req: CreateTerminalRequest,
) -> Result<(), String> {
    state.pty_manager.create(&app_handle, req)
}

#[tauri::command]
fn write_terminal(
    state: tauri::State<'_, AppState>,
    id: String,
    data: String,
) -> Result<(), String> {
    state.pty_manager.write(&id, &data)
}

#[tauri::command]
fn resize_terminal(
    state: tauri::State<'_, AppState>,
    id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    state.pty_manager.resize(&id, cols, rows)
}

#[tauri::command]
fn close_terminal(
    state: tauri::State<'_, AppState>,
    id: String,
) -> Result<(), String> {
    state.pty_manager.close(&id)
}

#[tauri::command]
fn create_claude_session(
    state: tauri::State<'_, AppState>,
    app_handle: tauri::AppHandle,
    req: CreateClaudeRequest,
) -> Result<(), String> {
    let settings_path = if req.permission_mode != "bypass_all" {
        state.permission_server.register_session(&req.session_id).ok().map(|(_, p)| p.to_string_lossy().to_string())
    } else { None };
    let channel = req.channel_server.clone();
    state.claude_manager.create_session(&app_handle, req, settings_path, channel)
}

#[tauri::command]
fn send_claude_prompt(
    state: tauri::State<'_, AppState>,
    app_handle: tauri::AppHandle,
    req: SendClaudePromptRequest,
) -> Result<(), String> {
    let settings_path = if req.permission_mode != "bypass_all" {
        state.permission_server.register_session(&req.session_id).ok().map(|(_, p)| p.to_string_lossy().to_string())
    } else { None };
    let channel = req.channel_server.clone();
    state.claude_manager.send_prompt(&app_handle, req, settings_path, channel)
}

#[tauri::command]
fn cancel_claude(
    state: tauri::State<'_, AppState>,
    session_id: String,
) -> Result<(), String> {
    state.claude_manager.cancel(&session_id)
}

#[tauri::command]
fn close_claude_session(
    state: tauri::State<'_, AppState>,
    session_id: String,
) -> Result<(), String> {
    // Clean up permission server temp files for this session
    let tokens_to_remove: Vec<String> = {
        let map = state.permission_server.session_map.lock().unwrap();
        map.iter().filter(|(_, sid)| **sid == session_id).map(|(t, _)| t.clone()).collect()
    };
    for token in tokens_to_remove {
        state.permission_server.unregister_session(&token);
    }
    state.claude_manager.close(&session_id)
}

#[tauri::command]
fn rewrite_prompt(app_handle: tauri::AppHandle, prompt: String) -> Result<String, String> {
    const SYSTEM_PROMPT: &str = "You are a prompt engineering expert. Your job is to rewrite user prompts to get dramatically better results from AI coding assistants like Claude Code.\n\nRules:\n- Keep the user's INTENT exactly the same\n- Make the prompt more specific, structured, and actionable\n- Add context that was implied but not stated\n- Break vague requests into clear, concrete steps\n- Specify expected output format when helpful\n- Add constraints that prevent common failure modes\n- If the prompt references code, remind the AI to read relevant files first\n- Keep it concise — longer isn't better, clearer is better\n- Don't add fluff or meta-commentary, just output the improved prompt\n- Output ONLY the rewritten prompt, nothing else";

    static REWRITE_COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let rewrite_id = format!("rw-{}", REWRITE_COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed));

    let full_prompt = format!("{}\n\nRewrite this prompt:\n{}", SYSTEM_PROMPT, prompt);
    let claude_bin = claude_manager::resolve_claude_path();
    let mut cmd = std::process::Command::new(&claude_bin);
    cmd.arg("-p").arg(&full_prompt)
        .arg("--output-format").arg("stream-json")
        .arg("--verbose")
        .arg("--include-partial-messages")
        .arg("--model").arg("haiku")
        .arg("--effort").arg("high")
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .stdin(std::process::Stdio::null());

    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000);
    }

    let mut child = cmd.spawn().map_err(|e| format!("Failed to spawn claude: {}", e))?;
    let stdout = child.stdout.take().ok_or("No stdout")?;

    // Log stderr for debugging
    if let Some(stderr) = child.stderr.take() {
        std::thread::spawn(move || {
            use std::io::BufRead;
            let reader = std::io::BufReader::new(stderr);
            for line in reader.lines().flatten() {
                eprintln!("[rewrite:stderr] {}", line);
            }
        });
    }

    let rid = rewrite_id.clone();
    std::thread::spawn(move || {
        use std::io::BufRead;
        let reader = std::io::BufReader::new(stdout);
        for line in reader.lines().flatten() {
            if line.trim().is_empty() { continue; }
            if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&line) {
                let event_type = parsed["type"].as_str().unwrap_or("");
                if event_type == "content_block_delta" {
                    if let Some(text) = parsed["delta"]["text"].as_str() {
                        let _ = app_handle.emit("rewrite-chunk", serde_json::json!({ "id": rid, "text": text }));
                    }
                } else if event_type == "assistant" {
                    if let Some(content) = parsed["message"]["content"].as_array() {
                        for block in content {
                            if block["type"].as_str() == Some("text") {
                                if let Some(text) = block["text"].as_str() {
                                    let _ = app_handle.emit("rewrite-chunk", serde_json::json!({ "id": rid, "text": text }));
                                }
                            }
                        }
                    }
                }
            }
        }
        let _ = app_handle.emit("rewrite-done", serde_json::json!({ "id": rid }));
        eprintln!("[rewrite] Done ({})", rid);
    });

    Ok(rewrite_id)
}

#[tauri::command]
async fn search_files(cwd: String, query: String) -> Result<Vec<String>, String> {
    // Run filesystem walk on a blocking thread to avoid freezing the UI
    tauri::async_runtime::spawn_blocking(move || {
        let root = std::path::Path::new(&cwd);
        if !root.is_dir() { return vec![]; }
        let query_lower = query.to_lowercase();
        let mut results = Vec::new();
        fn walk(dir: &std::path::Path, root: &std::path::Path, query: &str, results: &mut Vec<String>, skip: &[&str], depth: u8) {
            if depth > 6 || results.len() >= 20 { return; }
            let Ok(entries) = std::fs::read_dir(dir) else { return };
            for entry in entries.flatten() {
                if results.len() >= 20 { return; }
                let path = entry.path();
                let name = entry.file_name().to_string_lossy().to_string();
                if skip.iter().any(|s| name == *s) { continue; }
                let rel = path.strip_prefix(root).unwrap_or(&path).to_string_lossy().replace('\\', "/");
                if rel.to_lowercase().contains(query) || name.to_lowercase().contains(query) {
                    results.push(rel);
                }
                if path.is_dir() {
                    walk(&path, root, query, results, skip, depth + 1);
                }
            }
        }
        walk(root, root, &query_lower, &mut results, SKIP_DIRS, 0);
        results.sort_by(|a, b| a.len().cmp(&b.len()));
        results.truncate(12);
        results
    }).await.map_err(|e| e.to_string())
}

#[derive(serde::Serialize)]
struct DiskSession {
    id: String,
    modified: u64,
    size: u64,
    summary: String,
}

#[derive(serde::Serialize)]
struct HistoryToolCall {
    id: String,
    name: String,
    input: serde_json::Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    result: Option<String>,
    #[serde(default)]
    is_error: bool,
}

#[derive(serde::Serialize)]
struct HistoryMessage {
    id: String,
    role: String,  // "user" or "assistant"
    content: String,
    timestamp: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    tool_calls: Option<Vec<HistoryToolCall>>,
}

fn extract_session_summary(path: &std::path::Path) -> String {
    use std::io::{Read, Seek, SeekFrom};
    // Read the tail of the file to find the last "last-prompt" event
    let mut file = match std::fs::File::open(path) { Ok(f) => f, Err(_) => return String::new() };
    let len = file.metadata().map(|m| m.len()).unwrap_or(0);
    let tail_size = 4096u64.min(len);
    if tail_size == 0 { return String::new(); }
    let _ = file.seek(SeekFrom::End(-(tail_size as i64)));
    let mut buf = String::new();
    let _ = file.read_to_string(&mut buf);

    for line in buf.lines().rev() {
        let val: serde_json::Value = match serde_json::from_str(line) { Ok(v) => v, Err(_) => continue };
        if val["type"] == "last-prompt" {
            if let Some(s) = val["lastPrompt"].as_str() {
                return s.chars().take(120).collect();
            }
        }
    }
    String::new()
}

#[tauri::command]
fn list_disk_sessions(cwd: String) -> Result<Vec<DiskSession>, String> {
    let project_dir = session_project_dir(&cwd)?;
    if !project_dir.exists() { return Ok(vec![]); }

    let mut sessions = Vec::new();
    if let Ok(entries) = std::fs::read_dir(&project_dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) != Some("jsonl") { continue; }
            let id = path.file_stem().and_then(|s| s.to_str()).unwrap_or("").to_string();
            if id.is_empty() { continue; }
            let meta = std::fs::metadata(&path).ok();
            let modified = meta.as_ref()
                .and_then(|m| m.modified().ok())
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_secs())
                .unwrap_or(0);
            let size = meta.map(|m| m.len()).unwrap_or(0);
            let summary = extract_session_summary(&path);
            sessions.push(DiskSession { id, modified, size, summary });
        }
    }
    // Sort newest first
    sessions.sort_by(|a, b| b.modified.cmp(&a.modified));
    Ok(sessions)
}

#[tauri::command]
fn load_session_history(session_id: String, cwd: String) -> Result<Vec<HistoryMessage>, String> {
    let path = session_jsonl_path(&cwd, &session_id)?;
    let content = match std::fs::read_to_string(&path) {
        Ok(c) => c,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(vec![]),
        Err(e) => return Err(format!("read: {}", e)),
    };
    let mut messages: Vec<HistoryMessage> = Vec::new();
    // Track tool_use_id → index in messages vec + index in tool_calls vec for result merging
    let mut tool_index: std::collections::HashMap<String, (usize, usize)> = std::collections::HashMap::new();

    for line in content.lines() {
        let val: serde_json::Value = match serde_json::from_str(line) { Ok(v) => v, Err(_) => continue };
        let rec_type = val["type"].as_str().unwrap_or("");

        if rec_type == "user" {
            let msg = &val["message"];
            let role = msg["role"].as_str().unwrap_or("user");
            if role != "user" { continue; }

            let content_val = &msg["content"];
            // Content can be a string (simple prompt) or array (with tool_results)
            if let Some(text) = content_val.as_str() {
                let uuid = val["uuid"].as_str().unwrap_or("").to_string();
                let ts = parse_timestamp(val["timestamp"].as_str().unwrap_or(""));
                if !text.is_empty() {
                    messages.push(HistoryMessage {
                        id: uuid, role: "user".to_string(), content: text.to_string(), timestamp: ts, tool_calls: None,
                    });
                }
            } else if let Some(blocks) = content_val.as_array() {
                // Array content = tool_results from a previous assistant turn
                for block in blocks {
                    if block["type"].as_str() == Some("tool_result") {
                        let tool_use_id = block["tool_use_id"].as_str().unwrap_or("");
                        if let Some(&(msg_idx, tc_idx)) = tool_index.get(tool_use_id) {
                            if let Some(tcs) = messages[msg_idx].tool_calls.as_mut() {
                                let result_text = if let Some(s) = block["content"].as_str() {
                                    s.to_string()
                                } else if let Some(arr) = block["content"].as_array() {
                                    arr.iter().filter_map(|c| {
                                        if c["type"].as_str() == Some("text") { c["text"].as_str().map(|s| s.to_string()) }
                                        else { None }
                                    }).collect::<Vec<_>>().join("\n")
                                } else {
                                    String::new()
                                };
                                tcs[tc_idx].result = Some(result_text);
                                tcs[tc_idx].is_error = block["is_error"].as_bool().unwrap_or(false);
                            }
                        }
                    }
                }
            }
        } else if rec_type == "assistant" {
            let msg = &val["message"];
            let content_arr = match msg["content"].as_array() { Some(a) => a, None => continue };
            let uuid = val["uuid"].as_str().unwrap_or("").to_string();
            let ts = parse_timestamp(val["timestamp"].as_str().unwrap_or(""));

            let mut text = String::new();
            let mut tool_calls: Vec<HistoryToolCall> = Vec::new();

            for block in content_arr {
                match block["type"].as_str() {
                    Some("text") => {
                        if let Some(t) = block["text"].as_str() {
                            text.push_str(t);
                        }
                    }
                    Some("tool_use") => {
                        let tc_id = block["id"].as_str().unwrap_or("").to_string();
                        let tc_name = block["name"].as_str().unwrap_or("").to_string();
                        let tc_input = block["input"].clone();
                        tool_calls.push(HistoryToolCall {
                            id: tc_id.clone(), name: tc_name, input: tc_input, result: None, is_error: false,
                        });
                        // Register for result merging
                        tool_index.insert(tc_id, (messages.len(), tool_calls.len() - 1));
                    }
                    _ => {}
                }
            }

            let trimmed = text.trim().to_string();
            if !trimmed.is_empty() || !tool_calls.is_empty() {
                messages.push(HistoryMessage {
                    id: uuid,
                    role: "assistant".to_string(),
                    content: trimmed,
                    timestamp: ts,
                    tool_calls: if tool_calls.is_empty() { None } else { Some(tool_calls) },
                });
            }
        }
        // Skip queue-operation, last-prompt, etc.
    }
    Ok(messages)
}

/// Collect JSONL lines up to `keep_turns` user messages (actual user prompts, not tool_result-only messages).
fn collect_jsonl_lines_up_to_turns<'a>(content: &'a str, keep_turns: usize) -> Vec<&'a str> {
    let mut kept: Vec<&str> = Vec::new();
    let mut user_turn_count = 0;
    for line in content.lines() {
        if line.trim().is_empty() { continue; }
        let val: serde_json::Value = match serde_json::from_str(line) { Ok(v) => v, Err(_) => { kept.push(line); continue; } };
        if val["type"].as_str().unwrap_or("") == "user" {
            let is_real = val["message"]["content"].as_str().map(|s| !s.is_empty()).unwrap_or_else(||
                val["message"]["content"].as_array().map(|arr| arr.iter().any(|b| b["type"].as_str() == Some("text"))).unwrap_or(false)
            );
            if is_real { user_turn_count += 1; }
        }
        if user_turn_count > keep_turns { break; }
        kept.push(line);
    }
    kept
}

#[tauri::command]
fn truncate_session_jsonl(session_id: String, cwd: String, keep_turns: usize) -> Result<(), String> {
    let path = session_jsonl_path(&cwd, &session_id)?;
    let content = std::fs::read_to_string(&path).map_err(|e| format!("read: {}", e))?;
    let kept = collect_jsonl_lines_up_to_turns(&content, keep_turns);
    let truncated = kept.join("\n") + "\n";
    std::fs::write(&path, truncated).map_err(|e| format!("write: {}", e))?;
    eprintln!("[rewind] Truncated JSONL to {} turns (was {} lines, now {} lines)", keep_turns, content.lines().count(), kept.len());
    Ok(())
}

#[tauri::command]
fn fork_session_jsonl(parent_session_id: String, new_session_id: String, cwd: String, keep_turns: usize) -> Result<(), String> {
    let src = session_jsonl_path(&cwd, &parent_session_id)?;
    let content = std::fs::read_to_string(&src).map_err(|e| format!("read: {}", e))?;
    let kept = collect_jsonl_lines_up_to_turns(&content, keep_turns);
    let dest = session_jsonl_path(&cwd, &new_session_id)?;
    let truncated = kept.join("\n") + "\n";
    std::fs::write(&dest, truncated).map_err(|e| format!("write: {}", e))?;
    eprintln!("[fork] Copied {} -> {} ({} turns, {} lines)", parent_session_id, new_session_id, keep_turns, kept.len());
    Ok(())
}

fn parse_timestamp(ts: &str) -> f64 {
    chrono::DateTime::parse_from_rfc3339(ts)
        .or_else(|_| chrono::DateTime::parse_from_rfc3339(&format!("{}Z", ts)))
        .map(|dt| dt.timestamp_millis() as f64)
        .unwrap_or(0.0)
}

#[tauri::command]
fn resolve_permission(
    state: tauri::State<'_, AppState>,
    request_id: String,
    allow: bool,
) -> Result<(), String> {
    let reason = if allow { "Approved by user" } else { "Denied by user" };
    state.permission_server.resolve(&request_id, allow, reason);
    Ok(())
}

#[tauri::command]
fn list_directory(path: String) -> Result<Vec<DirEntry>, String> {
    let root = std::path::Path::new(&path);
    if !root.is_dir() { return Err("Not a directory".into()); }
    let mut entries = Vec::new();
    let Ok(rd) = std::fs::read_dir(root) else { return Ok(entries); };
    for entry in rd.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if SKIP_DIRS.iter().any(|s| name == *s) { continue; }
        if name.starts_with('.') && name != ".." { continue; }
        let is_dir = entry.path().is_dir();
        entries.push(DirEntry { name, is_dir });
    }
    entries.sort_by(|a, b| match (a.is_dir, b.is_dir) {
        (true, false) => std::cmp::Ordering::Less,
        (false, true) => std::cmp::Ordering::Greater,
        _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
    });
    Ok(entries)
}

#[tauri::command]
fn read_file(path: String) -> Result<String, String> {
    std::fs::read_to_string(&path).map_err(|e| format!("Failed to read {}: {}", path, e))
}

#[tauri::command]
fn write_file(path: String, content: String) -> Result<(), String> {
    std::fs::write(&path, &content).map_err(|e| format!("Failed to write {}: {}", path, e))
}

#[tauri::command]
fn list_mcp_servers(cwd: String) -> Result<Vec<McpServer>, String> {
    let mut servers = Vec::new();
    let mut seen = std::collections::HashSet::new();

    if let Some(home) = dirs::home_dir() {
        for name in &["settings.json", "settings.local.json"] {
            let path = home.join(".claude").join(name);
            if let Ok(data) = std::fs::read_to_string(&path) {
                if let Ok(val) = serde_json::from_str::<serde_json::Value>(&data) {
                    if let Some(obj) = val.get("mcpServers").and_then(|v| v.as_object()) {
                        for (name, cfg) in obj {
                            if seen.insert(name.clone()) {
                                servers.push(McpServer {
                                    name: name.clone(),
                                    transport: cfg.get("type").or(cfg.get("transport"))
                                        .and_then(|v| v.as_str()).unwrap_or("stdio").to_string(),
                                    command: cfg.get("command").and_then(|v| v.as_str())
                                        .or_else(|| cfg.get("url").and_then(|v| v.as_str()))
                                        .unwrap_or("").to_string(),
                                    scope: "user".to_string(),
                                });
                            }
                        }
                    }
                }
            }
        }
    }

    let project_mcp = std::path::Path::new(&cwd).join(".mcp.json");
    if let Ok(data) = std::fs::read_to_string(&project_mcp) {
        if let Ok(val) = serde_json::from_str::<serde_json::Value>(&data) {
            if let Some(obj) = val.get("mcpServers").and_then(|v| v.as_object()) {
                for (name, cfg) in obj {
                    if seen.insert(name.clone()) {
                        servers.push(McpServer {
                            name: name.clone(),
                            transport: cfg.get("type").or(cfg.get("transport"))
                                .and_then(|v| v.as_str()).unwrap_or("stdio").to_string(),
                            command: cfg.get("command").and_then(|v| v.as_str())
                                .or_else(|| cfg.get("url").and_then(|v| v.as_str()))
                                .unwrap_or("").to_string(),
                            scope: "project".to_string(),
                        });
                    }
                }
            }
        }
    }

    Ok(servers)
}

#[tauri::command]
fn list_slash_commands() -> Result<Vec<SlashCommand>, String> {
    let home = dirs::home_dir().ok_or("Cannot find home directory")?;
    let claude_dir = home.join(".claude");

    let mut commands = Vec::new();

    // Built-in Claude Code commands — (name, description, usage hint)
    let builtins: Vec<(&str, &str, Option<&str>)> = vec![
        ("add-dir", "Add a working directory for file access", Some("/add-dir <path>")),
        ("agents", "Manage agent configurations", None),
        ("branch", "Branch the conversation at this point", Some("/branch [name] — alias: /fork")),
        ("btw", "Ask a side question without adding to context", Some("/btw <question>")),
        ("clear", "Clear conversation history", None),
        ("color", "Set session prompt bar color", Some("/color [red|blue|green|yellow|purple|orange|pink|cyan|default]")),
        ("compact", "Compact conversation to save context", Some("/compact [instructions]")),
        ("config", "Open settings interface", None),
        ("context", "Visualize current context usage", None),
        ("copy", "Copy last assistant response to clipboard", Some("/copy [N] — N=2 for second-to-last")),
        ("cost", "Show token usage and cost for this session", None),
        ("diff", "Interactive diff viewer for uncommitted changes", None),
        ("doctor", "Check Claude Code setup for issues", None),
        ("effort", "Set model effort level", Some("/effort [low|medium|high|max|auto]")),
        ("export", "Export conversation as plain text", Some("/export [filename]")),
        ("fast", "Toggle fast mode", Some("/fast [on|off]")),
        ("feedback", "Submit feedback about Claude Code", None),
        ("help", "Show help and available commands", None),
        ("hooks", "View hook configurations for tool events", None),
        ("init", "Initialize a CLAUDE.md for this project", None),
        ("insights", "Generate session analysis report", None),
        ("keybindings", "Open keybindings configuration file", None),
        ("login", "Sign in to your Anthropic account", None),
        ("logout", "Sign out from your Anthropic account", None),
        ("mcp", "Manage MCP server connections", None),
        ("memory", "Edit CLAUDE.md memory files", None),
        ("model", "Switch the AI model", Some("/model [sonnet|opus|haiku]")),
        ("permissions", "View and manage tool permissions", None),
        ("plan", "Enter plan mode", Some("/plan [description]")),
        ("plugin", "Manage Claude Code plugins", None),
        ("pr-comments", "Fetch comments from a GitHub PR", Some("/pr-comments [PR number or URL]")),
        ("release-notes", "View the full changelog", None),
        ("rename", "Rename the current session", Some("/rename [name]")),
        ("resume", "Resume a conversation by ID or name", Some("/resume [session]")),
        ("rewind", "Rewind conversation to a previous point", None),
        ("schedule", "Create, update, or list scheduled remote agents", Some("/schedule [create|list|run] ...")),
        ("security-review", "Analyze pending changes for security vulnerabilities", None),
        ("skills", "List available skills", None),
        ("stats", "Visualize daily usage and session history", None),
        ("status", "Show version, model, account, and connectivity", None),
        ("tasks", "List and manage background tasks", None),
        ("theme", "Change the color theme", None),
        ("usage", "Show plan usage limits and rate limit status", None),
        ("voice", "Toggle push-to-talk voice dictation", None),
    ];
    for (name, desc, usage) in &builtins {
        commands.push(SlashCommand {
            name: name.to_string(),
            description: desc.to_string(),
            source: "built-in".to_string(),
            usage: usage.map(|u| u.to_string()),
        });
    }

    fn scan_dir(dir: &std::path::Path, commands: &mut Vec<SlashCommand>) {
        let Ok(entries) = std::fs::read_dir(dir) else { return };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                if path.file_name().map(|n| n == "skills").unwrap_or(false) {
                    if let Ok(skill_dirs) = std::fs::read_dir(&path) {
                        for skill_entry in skill_dirs.flatten() {
                            let skill_path = skill_entry.path();
                            if skill_path.is_dir() {
                                let skill_md = skill_path.join("SKILL.md");
                                if skill_md.exists() {
                                    if let Some(cmd) = parse_skill_md(&skill_md, &skill_path) {
                                        commands.push(cmd);
                                    }
                                }
                            }
                        }
                    }
                } else if path.file_name().map(|n| n == "commands").unwrap_or(false) {
                    if let Ok(cmd_files) = std::fs::read_dir(&path) {
                        for cmd_entry in cmd_files.flatten() {
                            let cmd_path = cmd_entry.path();
                            if cmd_path.extension().map(|e| e == "md").unwrap_or(false) {
                                if let Some(cmd) = parse_command_md(&cmd_path) {
                                    commands.push(cmd);
                                }
                            }
                        }
                    }
                } else if path.file_name().map(|n| n == "node_modules" || n == ".git").unwrap_or(false) {
                    // Skip
                } else {
                    scan_dir(&path, commands);
                }
            }
        }
    }

    fn parse_frontmatter(content: &str) -> Option<(&str, &str)> {
        let content = content.trim_start();
        if !content.starts_with("---") { return None; }
        let rest = &content[3..];
        let end = rest.find("---")?;
        Some((rest[..end].trim(), rest[end + 3..].trim()))
    }

    fn extract_yaml_field<'a>(yaml: &'a str, field: &str) -> Option<&'a str> {
        for line in yaml.lines() {
            let trimmed = line.trim();
            if let Some(rest) = trimmed.strip_prefix(field) {
                if let Some(rest) = rest.strip_prefix(':') {
                    let val = rest.trim().trim_matches('"').trim_matches('\'');
                    if !val.is_empty() {
                        return Some(val);
                    }
                }
            }
        }
        None
    }

    fn derive_source(path: &std::path::Path) -> &str {
        for ancestor in path.ancestors() {
            if let Some(parent) = ancestor.parent() {
                if let Some(pname) = parent.file_name() {
                    if pname == "cache" || pname == "plugins" || pname == "marketplaces" {
                        if let Some(name) = ancestor.file_name() {
                            return name.to_str().unwrap_or("unknown");
                        }
                    }
                }
            }
        }
        "unknown"
    }

    fn parse_skill_md(path: &std::path::Path, skill_dir: &std::path::Path) -> Option<SlashCommand> {
        let content = std::fs::read_to_string(path).ok()?;
        let (yaml, _) = parse_frontmatter(&content)?;
        let name = extract_yaml_field(yaml, "name")
            .or_else(|| skill_dir.file_name()?.to_str())?;
        let desc = extract_yaml_field(yaml, "description").unwrap_or("");
        let source = derive_source(path);
        Some(SlashCommand {
            name: name.to_string(),
            description: desc.to_string(),
            source: source.to_string(),
            usage: None,
        })
    }

    fn parse_command_md(path: &std::path::Path) -> Option<SlashCommand> {
        let content = std::fs::read_to_string(path).ok()?;
        let name = path.file_stem()?.to_str()?;
        let desc = if let Some((yaml, _)) = parse_frontmatter(&content) {
            extract_yaml_field(yaml, "description").unwrap_or("").to_string()
        } else {
            String::new()
        };
        let source = derive_source(path);
        Some(SlashCommand {
            name: name.to_string(),
            description: desc,
            source: source.to_string(),
            usage: None,
        })
    }

    // Scan plugins cache (installed versions)
    let cache_dir = claude_dir.join("plugins").join("cache");
    if cache_dir.exists() {
        scan_dir(&cache_dir, &mut commands);
    }

    // Scan user-level skills (~/.claude/skills/)
    let user_skills = claude_dir.join("skills");
    if user_skills.exists() {
        if let Ok(entries) = std::fs::read_dir(&user_skills) {
            for entry in entries.flatten() {
                let skill_path = entry.path();
                if skill_path.is_dir() {
                    let skill_md = skill_path.join("SKILL.md");
                    if skill_md.exists() {
                        if let Some(mut cmd) = parse_skill_md(&skill_md, &skill_path) {
                            cmd.source = "user".to_string();
                            commands.push(cmd);
                        }
                    }
                }
            }
        }
    }

    // Scan project-level skills (.claude/skills/)
    if let Ok(cwd) = std::env::current_dir() {
        let project_skills = cwd.join(".claude").join("skills");
        if project_skills.exists() {
            if let Ok(entries) = std::fs::read_dir(&project_skills) {
                for entry in entries.flatten() {
                    let skill_path = entry.path();
                    if skill_path.is_dir() {
                        let skill_md = skill_path.join("SKILL.md");
                        if skill_md.exists() {
                            if let Some(mut cmd) = parse_skill_md(&skill_md, &skill_path) {
                                cmd.source = "project".to_string();
                                commands.push(cmd);
                            }
                        }
                    }
                }
            }
        }
    }

    // Scan user-level commands (~/.claude/commands/)
    let user_cmds = claude_dir.join("commands");
    if user_cmds.exists() {
        if let Ok(entries) = std::fs::read_dir(&user_cmds) {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.extension().map(|e| e == "md").unwrap_or(false) {
                    if let Some(mut cmd) = parse_command_md(&path) {
                        cmd.source = "user".to_string();
                        commands.push(cmd);
                    }
                }
            }
        }
    }

    // Scan project-level .claude/commands/
    if let Ok(cwd) = std::env::current_dir() {
        let project_cmds = cwd.join(".claude").join("commands");
        if project_cmds.exists() {
            if let Ok(entries) = std::fs::read_dir(&project_cmds) {
                for entry in entries.flatten() {
                    let path = entry.path();
                    if path.extension().map(|e| e == "md").unwrap_or(false) {
                        if let Some(mut cmd) = parse_command_md(&path) {
                            cmd.source = "project".to_string();
                            commands.push(cmd);
                        }
                    }
                }
            }
        }
    }

    // Deduplicate by name (keep first occurrence — builtins first, then cache, then marketplace)
    commands.sort_by(|a, b| a.name.cmp(&b.name));
    commands.dedup_by(|a, b| a.name == b.name);

    Ok(commands)
}

#[tauri::command]
fn start_discord_bot(
    state: tauri::State<'_, AppState>,
    app_handle: tauri::AppHandle,
    token: String,
    guild_id: String,
) -> Result<(), String> {
    let gid: u64 = guild_id.parse().map_err(|_| "Invalid guild ID")?;
    let mut bot = state.discord_bot.lock().map_err(|e| e.to_string())?;
    bot.start(token, gid, app_handle, state.claude_manager.clone())
}

#[tauri::command]
fn stop_discord_bot(state: tauri::State<'_, AppState>) -> Result<(), String> {
    let mut bot = state.discord_bot.lock().map_err(|e| e.to_string())?;
    bot.stop()
}

#[tauri::command]
fn discord_bot_status(state: tauri::State<'_, AppState>) -> Result<bool, String> {
    let bot = state.discord_bot.lock().map_err(|e| e.to_string())?;
    Ok(bot.is_running())
}

#[tauri::command]
fn unlink_session_from_discord(
    state: tauri::State<'_, AppState>,
    session_id: String,
) -> Result<(), String> {
    let bot = state.discord_bot.lock().map_err(|e| e.to_string())?;
    bot.unlink_session(&session_id)
}

#[tauri::command]
fn link_session_to_discord(
    state: tauri::State<'_, AppState>,
    session_id: String,
    session_name: String,
    cwd: String,
) -> Result<(), String> {
    let bot = state.discord_bot.lock().map_err(|e| e.to_string())?;
    bot.link_session(session_id, session_name, cwd)
}

#[tauri::command]
fn rename_discord_session(
    state: tauri::State<'_, AppState>,
    session_id: String,
    session_name: String,
    cwd: String,
) -> Result<(), String> {
    let bot = state.discord_bot.lock().map_err(|e| e.to_string())?;
    bot.rename_or_link_session(session_id, session_name, cwd)
}

#[tauri::command]
fn discord_cleanup_orphaned(
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    let bot = state.discord_bot.lock().map_err(|e| e.to_string())?;
    bot.cleanup_orphaned()
}

#[tauri::command]
fn get_delegation_port(
    state: tauri::State<'_, AppState>,
) -> Result<u16, String> {
    Ok(state.permission_server.port())
}

#[tauri::command]
fn get_delegation_messages(
    state: tauri::State<'_, AppState>,
    group_id: String,
) -> Result<Vec<serde_json::Value>, String> {
    let msgs = state.permission_server.delegation_messages
        .lock().map_err(|e| e.to_string())?;
    let group_msgs = msgs.get(&group_id).cloned().unwrap_or_default();
    Ok(group_msgs.iter().map(|m| serde_json::json!({
        "agent": m.agent,
        "message": m.message,
        "timestamp": m.timestamp,
        "msg_type": m.msg_type,
    })).collect())
}

#[tauri::command]
fn cleanup_delegation_group(
    state: tauri::State<'_, AppState>,
    group_id: String,
) -> Result<(), String> {
    state.permission_server.cleanup_delegation_group(&group_id);
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let perm_server = PermissionServer::start(app.handle().clone())
                .expect("Failed to start permission server");
            app.manage(AppState {
                pty_manager: PtyManager::new(),
                claude_manager: Arc::new(ClaudeManager::new()),
                discord_bot: Mutex::new(DiscordBot::new()),
                permission_server: Arc::new(perm_server),
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            create_terminal,
            write_terminal,
            resize_terminal,
            close_terminal,
            create_claude_session,
            send_claude_prompt,
            cancel_claude,
            close_claude_session,
            list_slash_commands,
            start_discord_bot,
            stop_discord_bot,
            discord_bot_status,
            link_session_to_discord,
            unlink_session_from_discord,
            rename_discord_session,
            discord_cleanup_orphaned,
            resolve_permission,
            rewrite_prompt,
            search_files,
            list_disk_sessions,
            load_session_history,
            truncate_session_jsonl,
            fork_session_jsonl,
            read_file,
            write_file,
            list_mcp_servers,
            list_directory,
            get_delegation_port,
            get_delegation_messages,
            cleanup_delegation_group,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
