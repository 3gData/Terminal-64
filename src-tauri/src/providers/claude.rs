//! `ClaudeAdapter` — the Claude-CLI-backed implementation of `ProviderAdapter`.
//!
//! The CLI spawning / JSONL streaming / cancel / close code moved here from
//! the former `ClaudeManager` (`claude_manager.rs`) so Claude participates in
//! the same provider registry as Codex while preserving the existing
//! `claude-event` / `claude-done` stream shape.
//!
//! The provider registry calls this adapter through the same backend
//! create/send/cancel/close/history contract used by the other providers, so
//! the public IPC surface remains provider-neutral.
//!
//! Shared helpers (`shim_command`, `cap_event_size`,
//! `sanitize_dangling_tool_uses`) live in [`crate::providers::util`].
//! OpenWolf helpers stayed in `claude_manager.rs` for now — they aren't
//! provider-scoped and will move to a dedicated `openwolf.rs` later.

use serde::Deserialize;
use std::collections::HashMap;
use std::io::BufRead;
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter};

use crate::providers::emit_provider_event;
use crate::providers::traits::{
    ProviderAdapter, ProviderAdapterCapabilities, ProviderAdapterError,
    ProviderCreateSessionRequest, ProviderHistoryCapabilities, ProviderHistoryRequest,
    ProviderHistoryResponse, ProviderKind, ProviderSendPromptRequest,
    ProviderSessionModelSwitchMode,
};
use crate::providers::util::{
    cap_event_size, expanded_tool_path, find_existing_claude_session_jsonl,
    sanitize_dangling_tool_uses, shim_command,
};
use crate::types::{ClaudeDone, ClaudeEvent, CreateClaudeRequest, SendClaudePromptRequest};

// ── Binary discovery ───────────────────────────────────────

pub fn resolve_claude_path() -> String {
    // Try the platform-appropriate PATH lookup (GUI apps often have a limited PATH).
    // On Windows, pass the bare name (no extension) so `where` respects PATHEXT
    // and finds `.cmd`/`.bat` shims (npm-installed claude is usually a .cmd).
    let lookup = {
        let (cmd, arg) = if cfg!(windows) {
            ("where", "claude")
        } else {
            ("which", "claude")
        };
        let mut c = std::process::Command::new(cmd);
        c.arg(arg)
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .stdin(Stdio::null());
        #[cfg(target_os = "windows")]
        {
            use std::os::windows::process::CommandExt;
            c.creation_flags(0x08000000); // CREATE_NO_WINDOW
        }
        c.output()
    };
    if let Ok(p) = lookup {
        if p.status.success() {
            let s = String::from_utf8_lossy(&p.stdout)
                .lines()
                .next()
                .unwrap_or("")
                .trim()
                .to_string();
            if !s.is_empty() {
                return s;
            }
        }
    }

    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .ok();

    let mut candidates: Vec<String> = Vec::new();

    if cfg!(windows) {
        if let Some(ref h) = home {
            candidates.push(format!("{}\\.local\\bin\\claude.exe", h));
            candidates.push(format!("{}\\.local\\bin\\claude.cmd", h));
        }
        if let Ok(appdata) = std::env::var("APPDATA") {
            candidates.push(format!("{}\\npm\\claude.cmd", appdata));
            candidates.push(format!("{}\\npm\\claude.exe", appdata));
        }
        if let Ok(localappdata) = std::env::var("LOCALAPPDATA") {
            candidates.push(format!("{}\\Programs\\claude\\claude.exe", localappdata));
        }
    } else {
        if let Some(ref h) = home {
            candidates.push(format!("{}/.local/bin/claude", h));
            candidates.push(format!("{}/.npm-global/bin/claude", h));
        }
        candidates.push("/usr/local/bin/claude".to_string());
        candidates.push("/opt/homebrew/bin/claude".to_string());
    }

    for c in &candidates {
        if std::path::Path::new(c).exists() {
            return c.clone();
        }
    }
    #[cfg(target_os = "windows")]
    return "claude.cmd".to_string();
    #[cfg(not(target_os = "windows"))]
    return "claude".to_string();
}

// ── Session state + command builder ────────────────────────

struct ClaudeInstance {
    child: Child,
    generation: u64,
}

static GENERATION: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

// Claude CLI invocation needs every flag threaded through as a distinct argument; bundling
// these would just introduce an internal struct that maps 1:1 to parameters, with no real gain.
#[allow(clippy::too_many_arguments)]
fn build_command(
    session_flag: &str,
    session_value: &str,
    permission_mode: &str,
    model: &Option<String>,
    effort: &Option<String>,
    cwd: &str,
    disallowed_tools: &Option<String>,
    settings_path: &Option<String>,
    channel_server: &Option<String>,
    mcp_config: &Option<String>,
    approver_mcp_config: &Option<String>,
    resume_session_at: &Option<String>,
    max_turns: &Option<u32>,
    max_budget_usd: &Option<f64>,
    no_session_persistence: &Option<bool>,
    fork_session: &Option<String>,
) -> Command {
    let claude_bin = resolve_claude_path();
    let mut cmd = shim_command(&claude_bin);
    cmd.arg("--print")
        .arg("--output-format")
        .arg("stream-json")
        .arg("--verbose")
        .arg("--include-partial-messages")
        .arg(session_flag)
        .arg(session_value);

    match permission_mode {
        "bypass_all" => {
            cmd.arg("--permission-mode").arg("bypassPermissions");
        }
        "accept_edits" => {
            cmd.arg("--permission-mode").arg("acceptEdits");
        }
        "plan" => {
            cmd.arg("--permission-mode").arg("plan");
        }
        "auto" => {
            cmd.arg("--permission-mode").arg("auto");
        }
        _ => {
            cmd.arg("--permission-mode").arg("default");
        }
    }

    if let Some(m) = model {
        if !m.is_empty() {
            cmd.arg("--model").arg(m);
        }
    }
    if let Some(e) = effort {
        if !e.is_empty() {
            cmd.arg("--effort").arg(e);
        }
    }
    // ScheduleWakeup is globally disabled: the scheduler pathway doesn't work
    // for either normal chats or delegated agents, and leaving it enabled lets
    // the model schedule no-op wakeups. Always append to the disallow list.
    const ALWAYS_DISALLOWED: &str = "ScheduleWakeup";
    let merged_disallow: String = match disallowed_tools {
        Some(dt) if !dt.is_empty() => {
            if dt.split(',').any(|t| t.trim() == ALWAYS_DISALLOWED) {
                dt.clone()
            } else {
                format!("{},{}", dt, ALWAYS_DISALLOWED)
            }
        }
        _ => ALWAYS_DISALLOWED.to_string(),
    };
    cmd.arg("--disallowed-tools").arg(&merged_disallow);
    if let Some(sp) = settings_path {
        if !sp.is_empty() {
            cmd.arg("--settings").arg(sp);
        }
    }
    if let Some(ch) = channel_server {
        if !ch.is_empty() {
            cmd.arg("--dangerously-load-development-channels")
                .arg(format!("server:{}", ch));
        }
    }
    if !cwd.is_empty() && cwd != "." {
        cmd.current_dir(cwd);
    }
    if let Some(mc) = mcp_config {
        if !mc.is_empty() {
            cmd.arg("--mcp-config").arg(mc);
            cmd.arg("--strict-mcp-config");
        }
    }

    // Permission-prompt tool: a stdio MCP server shipped as a subcommand of
    // this same binary. Anthropic's sensitive-file classifier returns
    // `{behavior:"ask", type:"safetyCheck"}` for paths like `.mcp.json`,
    // `.zshrc`, `.git/*`, and `.claude/settings.json`, BEFORE bypass mode or
    // any PreToolUse hook can intervene. `--permission-prompt-tool` is the
    // only documented escape hatch.
    if let Some(amc) = approver_mcp_config {
        if !amc.is_empty() {
            cmd.arg("--mcp-config").arg(amc);
            cmd.arg("--permission-prompt-tool").arg("mcp__t64__approve");
        }
    }

    if let Some(uuid) = resume_session_at {
        if !uuid.is_empty() {
            cmd.arg("--resume-session-at").arg(uuid);
        }
    }

    if let Some(turns) = max_turns {
        cmd.arg("--max-turns").arg(turns.to_string());
    }
    if let Some(budget) = max_budget_usd {
        cmd.arg("--max-budget-usd").arg(budget.to_string());
    }
    if let Some(true) = no_session_persistence {
        cmd.arg("--no-session-persistence");
    }
    if let Some(parent_id) = fork_session {
        if !parent_id.is_empty() {
            cmd.arg("--fork-session").arg(parent_id);
        }
    }

    // Prompt is sent via stdin (see spawn_and_stream). We do NOT pass it as a
    // CLI arg because cmd.exe (used by shim_command on Windows) truncates
    // arguments at literal newline characters, silently losing multi-line
    // prompts.
    cmd.stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .stdin(Stdio::piped());
    cmd.env("PATH", expanded_tool_path());

    cmd
}

/// Resolve a session UUID up-front: use the caller-provided value if it
/// looks non-empty, otherwise mint a fresh `uuid::Uuid::new_v4()`.
fn resolve_session_id(provided: &str) -> String {
    let trimmed = provided.trim();
    if trimmed.is_empty() {
        uuid::Uuid::new_v4().to_string()
    } else {
        trimmed.to_string()
    }
}

/// Stderr pattern for a strict CLI that doesn't recognize `--session-id`.
fn stderr_rejects_session_id_flag(stderr: &str) -> bool {
    let lower = stderr.to_lowercase();
    (lower.contains("unrecognized") || lower.contains("unknown argument"))
        && lower.contains("session-id")
}

fn spawn_and_stream(
    instances: &Arc<Mutex<HashMap<String, ClaudeInstance>>>,
    app_handle: &AppHandle,
    session_id: String,
    cwd: &str,
    mut cmd: Command,
    prompt: &str,
) -> Result<(), String> {
    {
        let mut inst = instances.lock().map_err(|e| e.to_string())?;
        if let Some(mut old) = inst.remove(&session_id) {
            let _ = old.child.kill();
            let _ = old.child.wait();
            // Brief delay for OS to release file locks on session JSONL
            drop(inst); // release mutex before sleeping
            std::thread::sleep(std::time::Duration::from_millis(300));
        }
    }

    // Resume-path safety net: stitch a cancelled tool_result for any dangling
    // tool_use the previous run left behind so Claude CLI doesn't replay it.
    if let Err(e) = sanitize_dangling_tool_uses(cwd, &session_id) {
        safe_eprintln!(
            "[claude] sanitize_dangling_tool_uses({}): {}",
            session_id,
            e
        );
    }

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Failed to spawn claude: {}", e))?;

    // Write prompt to stdin and close it. Done in a thread so a very large
    // prompt cannot block this function if the child's stdin pipe buffer fills
    // before it begins reading.
    if let Some(mut stdin) = child.stdin.take() {
        let prompt_bytes = prompt.as_bytes().to_vec();
        std::thread::spawn(move || {
            use std::io::Write;
            if let Err(e) = stdin.write_all(&prompt_bytes) {
                safe_eprintln!("[claude] Failed to write prompt to stdin: {}", e);
            }
        });
    }

    let stdout = child.stdout.take().ok_or("Failed to capture stdout")?;

    // Capture stderr into a shared buffer so the stdout reader can surface errors.
    let stderr_buf: Arc<Mutex<String>> = Arc::new(Mutex::new(String::new()));
    if let Some(stderr) = child.stderr.take() {
        let sid_for_stderr = session_id.clone();
        let buf = stderr_buf.clone();
        std::thread::spawn(move || {
            let reader = std::io::BufReader::new(stderr);
            for line in reader.lines().map_while(Result::ok) {
                safe_eprintln!(
                    "[claude:stderr:{}] {}",
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
                    Err(e) => safe_eprintln!("[claude] Stderr buffer lock poisoned: {}", e),
                }
            }
        });
    }

    let gen = GENERATION.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let sid = session_id.clone();
    let handle = app_handle.clone();
    let instances_clone = instances.clone();

    std::thread::spawn(move || {
        safe_eprintln!("[claude] Reader thread started for {} (gen {})", sid, gen);
        let reader = std::io::BufReader::new(stdout);
        let mut had_output = false;
        for line in reader.lines() {
            match line {
                Ok(line) if line.trim().is_empty() => continue,
                Ok(line) => {
                    had_output = true;
                    let data = cap_event_size(line);
                    emit_provider_event(&handle, "anthropic", &sid, &data);
                    if let Err(e) = handle.emit(
                        "claude-event",
                        ClaudeEvent {
                            session_id: sid.clone(),
                            data,
                        },
                    ) {
                        safe_eprintln!("[claude] Failed to emit claude-event for {}: {}", sid, e);
                    }
                }
                Err(e) => {
                    safe_eprintln!("[claude] Reader error: {} for {}", e, sid);
                    break;
                }
            }
        }
        // If process produced no stdout, it likely failed — surface stderr as an error.
        if !had_output {
            std::thread::sleep(std::time::Duration::from_millis(150));
            let stderr_msg = stderr_buf.lock().map(|s| s.clone()).unwrap_or_default();
            let error_msg = if stderr_msg.is_empty() {
                "Claude process exited without output. The session may not exist or the CLI may not be installed.".to_string()
            } else if stderr_rejects_session_id_flag(&stderr_msg) {
                format!(
                    "claude_cli_rejects_session_id: {}. Update the claude CLI or remove `--session-id` from build_command().",
                    stderr_msg.trim()
                )
            } else {
                stderr_msg
            };
            safe_eprintln!(
                "[claude] No stdout output for {} — emitting error: {}",
                sid,
                &error_msg[..error_msg.len().min(200)]
            );
            let data = serde_json::json!({
                "type": "result",
                "subtype": "error",
                "is_error": true,
                "result": error_msg
            })
            .to_string();
            emit_provider_event(&handle, "anthropic", &sid, &data);
            if let Err(e) = handle.emit(
                "claude-event",
                ClaudeEvent {
                    session_id: sid.clone(),
                    data,
                },
            ) {
                safe_eprintln!("[claude] Failed to emit error event for {}: {}", sid, e);
            }
        }
        safe_eprintln!("[claude] Reader thread ended for {} (gen {})", sid, gen);
        // Only clean up and emit claude-done if this is still the current generation.
        // A newer generation means the session was re-spawned — emitting claude-done
        // from a stale reader would incorrectly flip isStreaming to false in the
        // frontend.
        let is_current = if let Ok(mut inst) = instances_clone.lock() {
            if let Some(instance) = inst.get(&sid) {
                if instance.generation == gen {
                    inst.remove(&sid);
                    true
                } else {
                    safe_eprintln!("[claude] Stale reader gen {} != current gen {} for {} — skipping claude-done", gen, instance.generation, sid);
                    false
                }
            } else {
                true // instance already removed, we're the last one
            }
        } else {
            true // lock failed, emit anyway to avoid silent hangs
        };
        if is_current {
            if let Err(e) = handle.emit(
                "claude-done",
                ClaudeDone {
                    session_id: sid.clone(),
                },
            ) {
                safe_eprintln!("[claude] Failed to emit claude-done for {}: {}", sid, e);
            }
        }
    });

    instances.lock().map_err(|e| e.to_string())?.insert(
        session_id,
        ClaudeInstance {
            child,
            generation: gen,
        },
    );

    Ok(())
}

// ── ClaudeAdapter ──────────────────────────────────────────

pub struct ClaudeAdapter {
    instances: Arc<Mutex<HashMap<String, ClaudeInstance>>>,
    capabilities: ProviderAdapterCapabilities,
}

#[derive(Deserialize)]
struct ClaudeHistoryTruncateRequest {
    session_id: String,
    cwd: String,
    keep_messages: usize,
}

#[derive(Deserialize)]
struct ClaudeHistoryForkRequest {
    parent_session_id: String,
    new_session_id: String,
    cwd: String,
    keep_messages: usize,
}

#[derive(Deserialize)]
struct ClaudeHistoryHydrateRequest {
    session_id: String,
    cwd: String,
    resume_at_uuid: Option<String>,
}

#[derive(Deserialize)]
struct ClaudeHistoryDeleteRequest {
    session_id: String,
    cwd: String,
}

impl ClaudeAdapter {
    pub fn new() -> Self {
        Self {
            instances: Arc::new(Mutex::new(HashMap::new())),
            capabilities: ProviderAdapterCapabilities {
                session_model_switch: ProviderSessionModelSwitchMode::InSession,
                history: ProviderHistoryCapabilities::FULL,
            },
        }
    }

    /// Spawn a new Claude CLI process for `req.session_id` (or a freshly minted
    /// UUID if empty). Returns the resolved session id so the frontend can
    /// adopt it without waiting on the `system/init` stream event.
    ///
    /// Signature preserved from the former `ClaudeManager::create_session` so
    /// the Tauri command layer (`lib.rs::create_claude_session`) stays
    /// byte-identical from the frontend's perspective.
    pub fn create_session(
        &self,
        app_handle: &AppHandle,
        req: CreateClaudeRequest,
        settings_path: Option<String>,
        approver_mcp_config: Option<String>,
        channel_server: Option<String>,
    ) -> Result<String, String> {
        let resolved_id = resolve_session_id(&req.session_id);
        safe_eprintln!(
            "[claude] Creating session id={} (provided={:?}) cwd={} mcp_config={:?}",
            resolved_id,
            if req.session_id == resolved_id {
                "as-is"
            } else {
                "regenerated"
            },
            req.cwd,
            req.mcp_config.as_deref().map(|s| &s[..s.len().min(80)])
        );
        let existing_jsonl = find_existing_claude_session_jsonl(&req.cwd, &resolved_id);
        let existing_jsonl_has_history = existing_jsonl
            .as_ref()
            .map(|_| match crate::load_session_history_impl(resolved_id.clone(), req.cwd.clone()) {
                Ok(messages) => !messages.is_empty(),
                Err(e) => {
                    safe_eprintln!(
                        "[claude] Failed to inspect existing JSONL for {}: {}; preserving resume behavior",
                        resolved_id,
                        e
                    );
                    true
                }
            })
            .unwrap_or(false);
        let session_flag = if existing_jsonl_has_history {
            "--resume"
        } else {
            "--session-id"
        };
        if let Some(path) = existing_jsonl
            .as_ref()
            .filter(|_| existing_jsonl_has_history)
        {
            safe_eprintln!(
                "[claude] Session id {} already has history at {}; using --resume for first visible turn",
                resolved_id,
                path.display()
            );
        } else if let Some(path) = existing_jsonl.as_ref() {
            safe_eprintln!(
                "[claude] Session id {} has JSONL at {} but no visible conversation; using --session-id",
                resolved_id,
                path.display()
            );
        }
        let cmd = build_command(
            session_flag,
            &resolved_id,
            &req.permission_mode,
            &req.model,
            &req.effort,
            &req.cwd,
            &None,
            &settings_path,
            &channel_server,
            &req.mcp_config,
            &approver_mcp_config,
            &None,
            &req.max_turns,
            &req.max_budget_usd,
            &req.no_session_persistence,
            &None,
        );
        let cwd = req.cwd.clone();
        let prompt = req.prompt.clone();
        spawn_and_stream(
            &self.instances,
            app_handle,
            resolved_id.clone(),
            &cwd,
            cmd,
            &prompt,
        )?;
        Ok(resolved_id)
    }

    /// Send a follow-up prompt to an existing session (uses `--resume`).
    pub fn send_prompt(
        &self,
        app_handle: &AppHandle,
        req: SendClaudePromptRequest,
        settings_path: Option<String>,
        approver_mcp_config: Option<String>,
        channel_server: Option<String>,
    ) -> Result<(), String> {
        safe_eprintln!(
            "[claude] Sending prompt to session {} (cwd: {}) resume_session_at={:?}",
            req.session_id,
            req.cwd,
            req.resume_session_at
        );
        let cmd = build_command(
            "--resume",
            &req.session_id,
            &req.permission_mode,
            &req.model,
            &req.effort,
            &req.cwd,
            &req.disallowed_tools,
            &settings_path,
            &channel_server,
            &None,
            &approver_mcp_config,
            &req.resume_session_at,
            &req.max_turns,
            &req.max_budget_usd,
            &req.no_session_persistence,
            &req.fork_session,
        );
        spawn_and_stream(
            &self.instances,
            app_handle,
            req.session_id,
            &req.cwd,
            cmd,
            &req.prompt,
        )
    }

    /// Kill the child process for `session_id` without removing its slot —
    /// the next `spawn_and_stream` replaces it after a short delay so file
    /// locks on the session JSONL release cleanly.
    pub fn cancel(&self, session_id: &str) -> Result<(), String> {
        let mut instances = self.instances.lock().map_err(|e| e.to_string())?;
        if let Some(instance) = instances.get_mut(session_id) {
            let _ = instance.child.kill();
            let _ = instance.child.wait();
            safe_eprintln!("[claude] Cancelled session {}", session_id);
        }
        Ok(())
    }

    pub fn close(&self, session_id: &str) -> Result<(), String> {
        let instance = self
            .instances
            .lock()
            .map_err(|e| e.to_string())?
            .remove(session_id);
        if let Some(mut instance) = instance {
            let _ = instance.child.kill();
            let _ = instance.child.wait();
            safe_eprintln!("[claude] Closed session {}", session_id);
        }
        Ok(())
    }
}

impl Default for ClaudeAdapter {
    fn default() -> Self {
        Self::new()
    }
}

impl ProviderAdapter for ClaudeAdapter {
    fn create_session(
        &self,
        app_handle: &AppHandle,
        req: ProviderCreateSessionRequest,
    ) -> Result<String, ProviderAdapterError> {
        let typed_req: CreateClaudeRequest = serde_json::from_value(req.payload)
            .map_err(|e| format!("Invalid Anthropic create request: {}", e))?;
        let channel_server = typed_req.channel_server.clone();
        ClaudeAdapter::create_session(
            self,
            app_handle,
            typed_req,
            req.context.settings_path,
            req.context.approver_mcp_config,
            channel_server,
        )
    }

    fn send_prompt(
        &self,
        app_handle: &AppHandle,
        req: ProviderSendPromptRequest,
    ) -> Result<(), ProviderAdapterError> {
        let typed_req: SendClaudePromptRequest = serde_json::from_value(req.payload)
            .map_err(|e| format!("Invalid Anthropic send request: {}", e))?;
        let channel_server = typed_req.channel_server.clone();
        ClaudeAdapter::send_prompt(
            self,
            app_handle,
            typed_req,
            req.context.settings_path,
            req.context.approver_mcp_config,
            channel_server,
        )
    }

    fn cancel_session(&self, session_id: &str) -> Result<(), ProviderAdapterError> {
        self.cancel(session_id)
    }

    fn close_session(&self, session_id: &str) -> Result<(), ProviderAdapterError> {
        self.close(session_id)
    }

    fn provider(&self) -> ProviderKind {
        ProviderKind::ClaudeAgent
    }

    fn capabilities(&self) -> &ProviderAdapterCapabilities {
        &self.capabilities
    }

    fn history_truncate(
        &self,
        req: ProviderHistoryRequest,
    ) -> Result<ProviderHistoryResponse, ProviderAdapterError> {
        let req: ClaudeHistoryTruncateRequest = serde_json::from_value(req)
            .map_err(|e| format!("Invalid Anthropic history truncate request: {}", e))?;
        if req.keep_messages == 0 {
            crate::delete_session_jsonl_impl(req.session_id, req.cwd)?;
            return Ok(serde_json::json!({
                "status": "applied",
                "method": "deleted_for_empty_rewind",
                "resume_at_uuid": null,
            }));
        }

        let resume_at_uuid =
            crate::find_rewind_uuid_impl(req.session_id, req.cwd, req.keep_messages)?;
        Ok(serde_json::json!({
            "status": "applied",
            "method": "resume_session_at",
            "resume_at_uuid": resume_at_uuid,
        }))
    }

    fn history_fork(
        &self,
        req: ProviderHistoryRequest,
    ) -> Result<ProviderHistoryResponse, ProviderAdapterError> {
        let req: ClaudeHistoryForkRequest = serde_json::from_value(req)
            .map_err(|e| format!("Invalid Anthropic history fork request: {}", e))?;
        let resume_at_uuid = crate::fork_session_jsonl_impl(
            req.parent_session_id,
            req.new_session_id,
            req.cwd,
            req.keep_messages,
        )?;
        Ok(serde_json::json!({
            "status": "applied",
            "resume_at_uuid": resume_at_uuid,
        }))
    }

    fn history_hydrate(
        &self,
        req: ProviderHistoryRequest,
    ) -> Result<ProviderHistoryResponse, ProviderAdapterError> {
        let req: ClaudeHistoryHydrateRequest = serde_json::from_value(req)
            .map_err(|e| format!("Invalid Anthropic history hydrate request: {}", e))?;
        let stat = crate::stat_session_jsonl_impl(req.session_id.clone(), req.cwd.clone())?;
        let messages =
            crate::load_session_history_at_impl(req.session_id, req.cwd, req.resume_at_uuid)?;
        let status = if messages.is_empty() {
            "empty"
        } else {
            "messages"
        };
        Ok(serde_json::json!({
            "status": status,
            "messages": messages,
            "stat": stat,
        }))
    }

    fn history_delete(
        &self,
        req: ProviderHistoryRequest,
    ) -> Result<ProviderHistoryResponse, ProviderAdapterError> {
        let req: ClaudeHistoryDeleteRequest = serde_json::from_value(req)
            .map_err(|e| format!("Invalid Anthropic history delete request: {}", e))?;
        crate::delete_session_jsonl_impl(req.session_id, req.cwd)?;
        Ok(serde_json::json!({
            "status": "applied",
            "method": "deleted",
        }))
    }
}
