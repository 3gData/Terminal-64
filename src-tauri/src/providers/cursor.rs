//! Cursor CLI adapter for the provider registry.
//!
//! Cursor's CLI exposes a non-interactive `cursor-agent -p` mode with
//! `--output-format stream-json`. The stream is forwarded as generic
//! `provider-event` payloads and normalized by the frontend decoder.

use serde::Deserialize;
use serde_json::Value;
use std::collections::HashMap;
use std::io::BufRead;
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use tauri::AppHandle;

use crate::providers::emit_provider_event;
use crate::providers::traits::{
    ProviderAdapter, ProviderAdapterCapabilities, ProviderAdapterError, ProviderCommandLifecycle,
    ProviderCreateSessionRequest, ProviderHistoryCapabilities, ProviderKind,
    ProviderPreparedCommand, ProviderSendPromptRequest, ProviderSessionModelSwitchMode,
};
use crate::providers::util::{cap_event_size, expanded_tool_path, shim_command};

struct CursorInstance {
    child: Child,
    generation: u64,
}

static GENERATION: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

#[derive(Debug, Deserialize)]
struct CursorRequest {
    session_id: String,
    #[serde(default)]
    thread_id: Option<String>,
    cwd: String,
    prompt: String,
    #[serde(default)]
    model: Option<String>,
    #[serde(default)]
    mode: Option<String>,
    #[serde(default)]
    permission_mode: Option<String>,
    #[serde(default)]
    force: Option<bool>,
    #[serde(default)]
    mcp_env: Option<HashMap<String, String>>,
}

pub fn resolve_cursor_agent_path() -> String {
    let lookup = {
        let (cmd, arg) = if cfg!(windows) {
            ("where", "cursor-agent")
        } else {
            ("which", "cursor-agent")
        };
        let mut c = Command::new(cmd);
        c.arg(arg)
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .stdin(Stdio::null())
            .env("PATH", expanded_tool_path());
        #[cfg(target_os = "windows")]
        {
            use std::os::windows::process::CommandExt;
            c.creation_flags(0x08000000);
        }
        c.output()
    };
    if let Ok(output) = lookup {
        if output.status.success() {
            let path = String::from_utf8_lossy(&output.stdout)
                .lines()
                .next()
                .unwrap_or("")
                .trim()
                .to_string();
            if !path.is_empty() {
                return path;
            }
        }
    }

    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .ok();
    let mut candidates = Vec::new();

    if cfg!(windows) {
        if let Ok(appdata) = std::env::var("APPDATA") {
            candidates.push(format!("{appdata}\\npm\\cursor-agent.cmd"));
            candidates.push(format!("{appdata}\\npm\\cursor-agent.exe"));
        }
        if let Some(ref h) = home {
            candidates.push(format!("{h}\\.local\\bin\\cursor-agent.exe"));
            candidates.push(format!("{h}\\.local\\bin\\cursor-agent.cmd"));
            candidates.push(format!("{h}\\.npm-global\\bin\\cursor-agent.cmd"));
        }
    } else {
        if let Some(ref h) = home {
            candidates.push(format!("{h}/.local/bin/cursor-agent"));
            candidates.push(format!("{h}/.npm-global/bin/cursor-agent"));
        }
        candidates.push("/usr/local/bin/cursor-agent".to_string());
        candidates.push("/opt/homebrew/bin/cursor-agent".to_string());
    }

    for candidate in &candidates {
        if std::path::Path::new(candidate).exists() {
            return candidate.clone();
        }
    }

    #[cfg(target_os = "windows")]
    return "cursor-agent.cmd".to_string();
    #[cfg(not(target_os = "windows"))]
    return "cursor-agent".to_string();
}

fn resolve_session_id(provided: &str) -> String {
    let trimmed = provided.trim();
    if trimmed.is_empty() {
        uuid::Uuid::new_v4().to_string()
    } else {
        trimmed.to_string()
    }
}

fn payload_cwd(payload: &serde_json::Value) -> Option<&str> {
    payload
        .get("cwd")
        .and_then(serde_json::Value::as_str)
        .filter(|cwd| !cwd.trim().is_empty())
}

fn payload_mcp_env(payload: &serde_json::Value) -> Option<HashMap<String, String>> {
    serde_json::from_value(payload.get("mcp_env")?.clone()).ok()
}

fn prepare_cursor_command(
    lifecycle: &ProviderCommandLifecycle<'_>,
    req: ProviderCreateSessionRequest,
    command_label: &str,
) -> ProviderPreparedCommand {
    let mcp_env = payload_mcp_env(&req.payload);
    if let Some(cwd) = payload_cwd(&req.payload) {
        if let Err(e) =
            crate::ensure_cursor_mcp_impl_with_env(lifecycle.app_handle, cwd, mcp_env.as_ref())
        {
            safe_eprintln!("[cursor:mcp] setup failed before {}: {}", command_label, e);
        }
    }
    ProviderPreparedCommand::new(req)
}

fn permission_forces_write(permission_mode: Option<&str>) -> bool {
    matches!(
        permission_mode,
        Some("bypass_all") | Some("accept_edits") | Some("auto") | Some("yolo") | Some("full-auto")
    )
}

fn apply_mcp_env(cmd: &mut Command, mcp_env: Option<&HashMap<String, String>>) {
    if let Some(env) = mcp_env {
        for (key, value) in env {
            cmd.env(key, value);
        }
    }
}

fn build_command(req: &CursorRequest, resume_thread_id: Option<&str>) -> Command {
    let cursor_bin = resolve_cursor_agent_path();
    let mut cmd = shim_command(&cursor_bin);
    cmd.arg("-p")
        .arg("--trust")
        .arg("--approve-mcps")
        .arg("--output-format")
        .arg("stream-json");

    if let Some(thread_id) = resume_thread_id {
        if !thread_id.trim().is_empty() {
            cmd.arg("--resume").arg(thread_id);
        }
    }

    if let Some(model) = req.model.as_deref() {
        if !model.trim().is_empty() && model != "auto" {
            cmd.arg("--model").arg(model);
        }
    }

    let mode = if req.permission_mode.as_deref() == Some("plan") {
        Some("plan")
    } else {
        req.mode.as_deref()
    };
    if let Some(mode) = mode.filter(|mode| matches!(*mode, "ask" | "plan")) {
        cmd.arg("--mode").arg(mode);
    }

    if req.force.unwrap_or(false) || permission_forces_write(req.permission_mode.as_deref()) {
        cmd.arg("--force");
    }

    if !req.cwd.is_empty() && req.cwd != "." {
        cmd.current_dir(&req.cwd);
    }
    cmd.stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .stdin(Stdio::piped())
        .env("PATH", expanded_tool_path());

    apply_mcp_env(&mut cmd, req.mcp_env.as_ref());

    cmd
}

fn approve_cursor_mcp(cwd: &str, mcp_env: Option<&HashMap<String, String>>) -> Result<(), String> {
    let cursor_bin = resolve_cursor_agent_path();
    let mut cmd = shim_command(&cursor_bin);
    cmd.arg("mcp")
        .arg("enable")
        .arg("terminal-64")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .env("PATH", expanded_tool_path());
    apply_mcp_env(&mut cmd, mcp_env);
    if !cwd.is_empty() && cwd != "." {
        cmd.current_dir(cwd);
    }

    match cmd.output() {
        Ok(output) if output.status.success() => Ok(()),
        Ok(output) => {
            let stderr = String::from_utf8_lossy(&output.stderr);
            let message = format!("Failed to approve terminal-64 MCP: {}", stderr.trim());
            safe_eprintln!("[cursor:mcp] {}", message);
            Err(message)
        }
        Err(e) => {
            let message = format!("Failed to run mcp enable: {}", e);
            safe_eprintln!("[cursor:mcp] {}", message);
            Err(message)
        }
    }
}

fn cursor_mcp_delegation_active(env: Option<&HashMap<String, String>>) -> bool {
    let Some(env) = env else {
        return false;
    };
    let port = env
        .get("T64_DELEGATION_PORT")
        .map(String::as_str)
        .unwrap_or("");
    let secret = env
        .get("T64_DELEGATION_SECRET")
        .map(String::as_str)
        .unwrap_or("");
    let group_id = env.get("T64_GROUP_ID").map(String::as_str).unwrap_or("");
    !port.is_empty() && port != "0" && !secret.is_empty() && !group_id.is_empty()
}

fn emit_cursor_mcp_status(
    handle: &AppHandle,
    session_id: &str,
    delegation_active: bool,
    approval: &Result<(), String>,
) {
    let tools = if delegation_active {
        serde_json::json!([
            { "name": "send_to_team" },
            { "name": "read_team" },
            { "name": "report_done" }
        ])
    } else {
        serde_json::json!([{ "name": "StartDelegation" }])
    };
    let status = if approval.is_ok() { "ready" } else { "error" };
    let mut server = serde_json::json!({
        "name": "terminal-64",
        "status": status,
        "transport": "stdio",
        "tools": tools,
    });
    if let Err(message) = approval {
        server["error"] = serde_json::json!(message);
    }
    let data = serde_json::json!({
        "type": "mcp_status",
        "servers": [server],
    })
    .to_string();
    emit_provider_event(handle, "cursor", session_id, &data);
}

fn cursor_session_id_from_event(line: &str) -> Option<String> {
    let parsed: Value = serde_json::from_str(line).ok()?;
    if parsed.get("type")?.as_str()? != "system" {
        return None;
    }
    if parsed.get("subtype")?.as_str()? != "init" {
        return None;
    }
    parsed
        .get("session_id")
        .and_then(Value::as_str)
        .filter(|id| !id.trim().is_empty())
        .map(ToString::to_string)
}

fn is_result_event(line: &str) -> bool {
    serde_json::from_str::<Value>(line)
        .ok()
        .and_then(|value| {
            value
                .get("type")
                .and_then(Value::as_str)
                .map(str::to_string)
        })
        .as_deref()
        == Some("result")
}

fn emit_cursor_error(handle: &AppHandle, session_id: &str, message: String) {
    let data = serde_json::json!({
        "type": "result",
        "is_error": true,
        "result": message,
    })
    .to_string();
    emit_provider_event(handle, "cursor", session_id, &data);
}

fn spawn_and_stream(
    instances: &Arc<Mutex<HashMap<String, CursorInstance>>>,
    cursor_sessions: &Arc<Mutex<HashMap<String, String>>>,
    app_handle: &AppHandle,
    session_id: String,
    mut cmd: Command,
    prompt: &str,
) -> Result<(), String> {
    {
        let mut instances = instances.lock().map_err(|e| e.to_string())?;
        if let Some(mut old) = instances.remove(&session_id) {
            let _ = old.child.kill();
            let _ = old.child.wait();
        }
    }

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Failed to spawn cursor-agent: {}", e))?;

    if let Some(mut stdin) = child.stdin.take() {
        let prompt_bytes = prompt.as_bytes().to_vec();
        std::thread::spawn(move || {
            use std::io::Write;
            if let Err(e) = stdin.write_all(&prompt_bytes) {
                safe_eprintln!("[cursor] Failed to write prompt to stdin: {}", e);
            }
        });
    }

    let stdout = child.stdout.take().ok_or("Failed to capture stdout")?;
    let stderr_buf = Arc::new(Mutex::new(String::new()));
    if let Some(stderr) = child.stderr.take() {
        let sid_for_stderr = session_id.clone();
        let buf = Arc::clone(&stderr_buf);
        std::thread::spawn(move || {
            let reader = std::io::BufReader::new(stderr);
            for line in reader.lines().map_while(Result::ok) {
                safe_eprintln!(
                    "[cursor:stderr:{}] {}",
                    &sid_for_stderr[..8.min(sid_for_stderr.len())],
                    line
                );
                match buf.lock() {
                    Ok(mut b) => {
                        if b.len() < 4000 {
                            if !b.is_empty() {
                                b.push('\n');
                            }
                            b.push_str(&line);
                        }
                    }
                    Err(e) => safe_eprintln!("[cursor] Stderr buffer lock poisoned: {}", e),
                }
            }
        });
    }

    let generation = GENERATION.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let sid = session_id.clone();
    let handle = app_handle.clone();
    let instances_clone = Arc::clone(instances);
    let cursor_sessions_clone = Arc::clone(cursor_sessions);

    std::thread::spawn(move || {
        safe_eprintln!(
            "[cursor] Reader thread started for {} (gen {})",
            sid,
            generation
        );
        let reader = std::io::BufReader::new(stdout);
        let mut had_output = false;
        let mut saw_result = false;

        for line in reader.lines() {
            match line {
                Ok(line) if line.trim().is_empty() => continue,
                Ok(line) => {
                    had_output = true;
                    if let Some(cursor_session_id) = cursor_session_id_from_event(&line) {
                        if let Ok(mut sessions) = cursor_sessions_clone.lock() {
                            sessions.insert(sid.clone(), cursor_session_id);
                        }
                    }
                    saw_result |= is_result_event(&line);
                    let data = cap_event_size(line);
                    emit_provider_event(&handle, "cursor", &sid, &data);
                }
                Err(e) => {
                    safe_eprintln!("[cursor] Reader error: {} for {}", e, sid);
                    break;
                }
            }
        }

        if !had_output {
            std::thread::sleep(std::time::Duration::from_millis(150));
            let stderr_msg = stderr_buf.lock().map(|s| s.clone()).unwrap_or_default();
            let error_msg = if stderr_msg.trim().is_empty() {
                "Cursor process exited without output. Install Cursor CLI and run `cursor-agent login` if authentication is required.".to_string()
            } else {
                stderr_msg
            };
            safe_eprintln!(
                "[cursor] No stdout output for {} - emitting error: {}",
                sid,
                &error_msg[..error_msg.len().min(200)]
            );
            emit_cursor_error(&handle, &sid, error_msg);
        } else if !saw_result {
            let data = serde_json::json!({
                "type": "result",
                "is_error": false,
                "result": "",
            })
            .to_string();
            emit_provider_event(&handle, "cursor", &sid, &data);
        }

        let is_current = if let Ok(mut instances) = instances_clone.lock() {
            if let Some(instance) = instances.get(&sid) {
                if instance.generation == generation {
                    instances.remove(&sid);
                    true
                } else {
                    safe_eprintln!(
                        "[cursor] Stale reader gen {} != current gen {} for {}",
                        generation,
                        instance.generation,
                        sid
                    );
                    false
                }
            } else {
                true
            }
        } else {
            true
        };
        if is_current {
            safe_eprintln!(
                "[cursor] Reader thread ended for {} (gen {})",
                sid,
                generation
            );
        }
    });

    instances
        .lock()
        .map_err(|e| e.to_string())?
        .insert(session_id, CursorInstance { child, generation });

    Ok(())
}

pub struct CursorAdapter {
    instances: Arc<Mutex<HashMap<String, CursorInstance>>>,
    cursor_sessions: Arc<Mutex<HashMap<String, String>>>,
    capabilities: ProviderAdapterCapabilities,
}

impl CursorAdapter {
    pub fn new() -> Self {
        Self {
            instances: Arc::new(Mutex::new(HashMap::new())),
            cursor_sessions: Arc::new(Mutex::new(HashMap::new())),
            capabilities: ProviderAdapterCapabilities {
                session_model_switch: ProviderSessionModelSwitchMode::InSession,
                history: ProviderHistoryCapabilities::NONE,
            },
        }
    }

    fn create_session(
        &self,
        app_handle: &AppHandle,
        mut req: CursorRequest,
    ) -> Result<String, String> {
        let resolved_id = resolve_session_id(&req.session_id);
        req.session_id = resolved_id.clone();
        let mcp_approval = approve_cursor_mcp(&req.cwd, req.mcp_env.as_ref());
        emit_cursor_mcp_status(
            app_handle,
            &resolved_id,
            cursor_mcp_delegation_active(req.mcp_env.as_ref()),
            &mcp_approval,
        );
        let cmd = build_command(&req, None);
        spawn_and_stream(
            &self.instances,
            &self.cursor_sessions,
            app_handle,
            resolved_id.clone(),
            cmd,
            &req.prompt,
        )?;
        Ok(resolved_id)
    }

    fn send_prompt(&self, app_handle: &AppHandle, req: CursorRequest) -> Result<(), String> {
        let local_session_id = resolve_session_id(&req.session_id);
        let mapped_thread_id = self
            .cursor_sessions
            .lock()
            .map_err(|e| e.to_string())?
            .get(&local_session_id)
            .cloned();
        let resume_thread_id = req.thread_id.as_deref().or(mapped_thread_id.as_deref());
        let mcp_approval = approve_cursor_mcp(&req.cwd, req.mcp_env.as_ref());
        emit_cursor_mcp_status(
            app_handle,
            &local_session_id,
            cursor_mcp_delegation_active(req.mcp_env.as_ref()),
            &mcp_approval,
        );
        let cmd = build_command(&req, resume_thread_id);
        spawn_and_stream(
            &self.instances,
            &self.cursor_sessions,
            app_handle,
            local_session_id,
            cmd,
            &req.prompt,
        )
    }

    fn cancel(&self, session_id: &str) -> Result<(), String> {
        let mut instances = self.instances.lock().map_err(|e| e.to_string())?;
        if let Some(instance) = instances.get_mut(session_id) {
            let _ = instance.child.kill();
            let _ = instance.child.wait();
            safe_eprintln!("[cursor] Cancelled session {}", session_id);
        }
        Ok(())
    }

    fn close(&self, session_id: &str) -> Result<(), String> {
        let instance = self
            .instances
            .lock()
            .map_err(|e| e.to_string())?
            .remove(session_id);
        if let Some(mut instance) = instance {
            let _ = instance.child.kill();
            let _ = instance.child.wait();
            safe_eprintln!("[cursor] Closed session {}", session_id);
        }
        if let Ok(mut sessions) = self.cursor_sessions.lock() {
            sessions.remove(session_id);
        }
        Ok(())
    }
}

impl Default for CursorAdapter {
    fn default() -> Self {
        Self::new()
    }
}

impl ProviderAdapter for CursorAdapter {
    fn prepare_create_session(
        &self,
        lifecycle: &ProviderCommandLifecycle<'_>,
        req: ProviderCreateSessionRequest,
    ) -> Result<ProviderPreparedCommand, ProviderAdapterError> {
        Ok(prepare_cursor_command(lifecycle, req, "create"))
    }

    fn prepare_send_prompt(
        &self,
        lifecycle: &ProviderCommandLifecycle<'_>,
        req: ProviderSendPromptRequest,
    ) -> Result<ProviderPreparedCommand, ProviderAdapterError> {
        Ok(prepare_cursor_command(lifecycle, req, "send"))
    }

    fn create_session(
        &self,
        app_handle: &AppHandle,
        req: ProviderCreateSessionRequest,
    ) -> Result<String, ProviderAdapterError> {
        let typed_req: CursorRequest = serde_json::from_value(req.payload)
            .map_err(|e| format!("Invalid Cursor create request: {}", e))?;
        CursorAdapter::create_session(self, app_handle, typed_req)
    }

    fn send_prompt(
        &self,
        app_handle: &AppHandle,
        req: ProviderSendPromptRequest,
    ) -> Result<(), ProviderAdapterError> {
        let typed_req: CursorRequest = serde_json::from_value(req.payload)
            .map_err(|e| format!("Invalid Cursor send request: {}", e))?;
        CursorAdapter::send_prompt(self, app_handle, typed_req)
    }

    fn cancel_session(&self, session_id: &str) -> Result<(), ProviderAdapterError> {
        self.cancel(session_id)
    }

    fn close_session(&self, session_id: &str) -> Result<(), ProviderAdapterError> {
        self.close(session_id)
    }

    fn provider(&self) -> ProviderKind {
        ProviderKind::Cursor
    }

    fn capabilities(&self) -> &ProviderAdapterCapabilities {
        &self.capabilities
    }
}
