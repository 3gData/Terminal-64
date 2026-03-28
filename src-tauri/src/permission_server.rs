use std::collections::HashMap;
use std::io::{BufRead, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter};

static REQ_COUNTER: AtomicU64 = AtomicU64::new(0);

fn next_id() -> String {
    format!("perm-{}", REQ_COUNTER.fetch_add(1, Ordering::Relaxed))
}

fn random_token() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let t = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default();
    format!("{:x}{:x}", t.as_nanos(), t.as_secs().wrapping_mul(2654435761))
}

pub struct PermissionServer {
    port: u16,
    secret: String,
    pending: Arc<Mutex<HashMap<String, mpsc::SyncSender<(bool, String)>>>>,
    pub(crate) session_map: Arc<Mutex<HashMap<String, String>>>, // run_token → session_id
    settings_files: Arc<Mutex<HashMap<String, PathBuf>>>, // run_token → temp file path
}

impl PermissionServer {
    pub fn start(app_handle: AppHandle) -> Result<Self, String> {
        let listener = TcpListener::bind("127.0.0.1:0").map_err(|e| format!("bind: {}", e))?;
        let port = listener.local_addr().map_err(|e| e.to_string())?.port();
        let secret = random_token();

        eprintln!("[perm-server] Listening on 127.0.0.1:{}", port);

        let pending: Arc<Mutex<HashMap<String, mpsc::SyncSender<(bool, String)>>>> =
            Arc::new(Mutex::new(HashMap::new()));
        let session_map: Arc<Mutex<HashMap<String, String>>> =
            Arc::new(Mutex::new(HashMap::new()));

        let s = secret.clone();
        let p = pending.clone();
        let sm = session_map.clone();

        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let stream = match stream {
                    Ok(s) => s,
                    Err(_) => continue,
                };
                let secret = s.clone();
                let pending = p.clone();
                let sessions = sm.clone();
                let app = app_handle.clone();
                std::thread::spawn(move || {
                    if let Err(e) = handle_connection(stream, &secret, &pending, &sessions, &app) {
                        eprintln!("[perm-server] Connection error: {}", e);
                    }
                });
            }
        });

        Ok(Self {
            port,
            secret,
            pending,
            session_map,
            settings_files: Arc::new(Mutex::new(HashMap::new())),
        })
    }

    /// Get or create a settings file for a session. Reuses existing registration.
    pub fn register_session(&self, session_id: &str) -> Result<(String, PathBuf), String> {
        // Reuse existing token if session is already registered
        {
            let map = self.session_map.lock().unwrap();
            for (token, sid) in map.iter() {
                if sid == session_id {
                    if let Some(path) = self.settings_files.lock().unwrap().get(token) {
                        return Ok((token.clone(), path.clone()));
                    }
                }
            }
        }

        let run_token = random_token();
        let url = format!(
            "http://127.0.0.1:{}/hook/{}/{}",
            self.port, self.secret, run_token
        );

        let settings = serde_json::json!({
            "hooks": {
                "PreToolUse": [{
                    "matcher": "",
                    "hooks": [{ "type": "http", "url": url }]
                }]
            }
        });

        let path = std::env::temp_dir().join(format!("t64-hook-{}.json", &run_token[..12]));
        std::fs::write(&path, settings.to_string()).map_err(|e| format!("write settings: {}", e))?;

        self.session_map
            .lock()
            .unwrap()
            .insert(run_token.clone(), session_id.to_string());
        self.settings_files
            .lock()
            .unwrap()
            .insert(run_token.clone(), path.clone());

        eprintln!(
            "[perm-server] Registered session {} with token {}",
            session_id,
            &run_token[..12]
        );
        Ok((run_token, path))
    }

    /// Unregister a session: remove mapping, delete temp file, deny pending requests.
    pub fn unregister_session(&self, run_token: &str) {
        self.session_map.lock().unwrap().remove(run_token);
        if let Some(path) = self.settings_files.lock().unwrap().remove(run_token) {
            let _ = std::fs::remove_file(path);
        }
    }

    /// Resolve a pending permission request.
    pub fn resolve(&self, request_id: &str, allow: bool, reason: &str) {
        if let Some(tx) = self.pending.lock().unwrap().remove(request_id) {
            let _ = tx.send((allow, reason.to_string()));
        }
    }
}

fn handle_connection(
    mut stream: TcpStream,
    secret: &str,
    pending: &Arc<Mutex<HashMap<String, mpsc::SyncSender<(bool, String)>>>>,
    sessions: &Arc<Mutex<HashMap<String, String>>>,
    app_handle: &AppHandle,
) -> Result<(), String> {
    stream
        .set_read_timeout(Some(Duration::from_secs(10)))
        .ok();

    // Read headers
    let mut reader = std::io::BufReader::new(&stream);
    let mut headers = String::new();
    loop {
        let mut line = String::new();
        match reader.read_line(&mut line) {
            Ok(0) => return Err("connection closed".into()),
            Ok(_) => {
                headers.push_str(&line);
                if line == "\r\n" || line == "\n" {
                    break;
                }
            }
            Err(e) => return Err(format!("read: {}", e)),
        }
    }

    // Parse first line
    let first_line = headers.lines().next().unwrap_or("");
    if !first_line.starts_with("POST ") {
        send_http(&mut stream, 405, r#"{"error":"method not allowed"}"#);
        return Ok(());
    }

    let path = first_line.split_whitespace().nth(1).unwrap_or("");

    // Parse path: /hook/{secret}/{run_token}
    let parts: Vec<&str> = path.split('/').collect();
    if parts.len() < 4 || parts[1] != "hook" || parts[2] != secret {
        send_http(&mut stream, 403, r#"{"error":"forbidden"}"#);
        return Ok(());
    }
    let run_token = parts[3].to_string();

    // Parse Content-Length
    let content_length: usize = headers
        .lines()
        .find(|l| l.to_lowercase().starts_with("content-length:"))
        .and_then(|l| l.split(':').nth(1))
        .and_then(|v| v.trim().parse().ok())
        .unwrap_or(0);

    // Read body
    let mut body = vec![0u8; content_length];
    if content_length > 0 {
        reader
            .read_exact(&mut body)
            .map_err(|e| format!("body read: {}", e))?;
    }
    let body_str = String::from_utf8_lossy(&body);
    let parsed: serde_json::Value = serde_json::from_str(&body_str).unwrap_or_default();

    let tool_name = parsed["tool_name"]
        .as_str()
        .unwrap_or("unknown")
        .to_string();
    let tool_input = parsed["tool_input"].clone();

    // Auto-approve safe/internal tools without prompting the user
    const AUTO_ALLOW: &[&str] = &[
        "Read", "Glob", "Grep", "LS", "WebSearch", "WebFetch", "TodoRead", "TodoWrite",
        "Agent", "EnterPlanMode", "ExitPlanMode", "TaskCreate", "TaskUpdate", "TaskGet",
        "TaskList", "TaskStop", "NotebookEdit", "ToolSearch",
    ];
    // Auto-approve writes to .claude/plans/ (plan files)
    let is_plan_file = tool_input["file_path"].as_str()
        .map(|p| p.contains(".claude/plans") || p.contains(".claude\\plans"))
        .unwrap_or(false);

    if AUTO_ALLOW.contains(&tool_name.as_str()) || is_plan_file {
        let resp = serde_json::json!({
            "hookSpecificOutput": {
                "hookEventName": "PreToolUse",
                "permissionDecision": "allow",
                "permissionDecisionReason": "Auto-approved by Terminal 64"
            }
        });
        send_http(&mut stream, 200, &resp.to_string());
        return Ok(());
    }

    // Look up session
    let session_id = sessions
        .lock()
        .unwrap()
        .get(&run_token)
        .cloned()
        .unwrap_or_default();

    if session_id.is_empty() {
        // Unknown token — allow by default (fail-open)
        let resp = serde_json::json!({
            "hookSpecificOutput": {
                "hookEventName": "PreToolUse",
                "permissionDecision": "allow",
                "permissionDecisionReason": "Unknown session"
            }
        });
        send_http(&mut stream, 200, &resp.to_string());
        return Ok(());
    }

    let request_id = next_id();
    eprintln!(
        "[perm-server] Permission request {} for {} in session {}: {}",
        request_id, tool_name, &session_id[..8.min(session_id.len())], tool_name
    );

    // Create channel and store sender
    let (tx, rx) = mpsc::sync_channel(1);
    pending.lock().unwrap().insert(request_id.clone(), tx);

    // Emit to frontend
    let _ = app_handle.emit(
        "permission-request",
        serde_json::json!({
            "request_id": request_id,
            "session_id": session_id,
            "tool_name": tool_name,
            "tool_input": tool_input,
        }),
    );

    // Wait for decision (5 minute timeout)
    // Remove read timeout so the connection stays open
    stream.set_read_timeout(None).ok();

    let (allow, reason) = match rx.recv_timeout(Duration::from_secs(300)) {
        Ok(decision) => decision,
        Err(_) => {
            pending.lock().unwrap().remove(&request_id);
            eprintln!("[perm-server] Timeout for request {}", request_id);
            (false, "Permission request timed out".to_string())
        }
    };

    let decision = if allow { "allow" } else { "deny" };
    eprintln!("[perm-server] Resolved {}: {}", request_id, decision);

    let resp = serde_json::json!({
        "hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "permissionDecision": decision,
            "permissionDecisionReason": reason
        }
    });
    send_http(&mut stream, 200, &resp.to_string());

    Ok(())
}

fn send_http(stream: &mut TcpStream, status: u16, body: &str) {
    let status_text = match status {
        200 => "OK",
        403 => "Forbidden",
        405 => "Method Not Allowed",
        _ => "Error",
    };
    let response = format!(
        "HTTP/1.1 {} {}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        status,
        status_text,
        body.len(),
        body
    );
    let _ = stream.write_all(response.as_bytes());
    let _ = stream.flush();
}
