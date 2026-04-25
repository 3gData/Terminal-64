//! `CodexAdapter` — OpenAI Codex CLI-backed implementation of `ProviderAdapter`.
//!
//! Spawns `codex exec --json` (NDJSON over stdout) for one-shot/initial turns
//! and `codex exec resume <thread_id> --json "<prompt>"` for follow-ups.
//! Parses the NDJSON event schema documented in
//! `codex-rs/exec/src/exec_events.rs` upstream and re-emits each line as a
//! `codex-event` Tauri event so the frontend can route by `session_id`.
//!
//! Supported flags (mapped from CreateCodexRequest / SendCodexPromptRequest):
//!   -m/--model <id>                                  → req.model
//!   -s/--sandbox {read-only|workspace-write|...}     → req.sandbox_mode
//!   --full-auto                                      → req.full_auto
//!   --dangerously-bypass-approvals-and-sandbox       → req.yolo
//!   --skip-git-repo-check                            → req.skip_git_repo_check
//!   -c approval_policy=<v>                           → req.approval_policy
//!   -c model_reasoning_effort=<v>                    → req.effort
//!   -C <cwd>                                         → req.cwd
//!
//! For Step 1 of the Codex port, multi-turn lives entirely in the CLI:
//! `codex exec resume <thread_id> ...` re-attaches to a prior session.
//! The frontend captures `thread.started.thread_id` from the first event
//! and stores it as the session's external id; subsequent prompts go
//! through `send_prompt` which uses the resume subcommand.

use async_trait::async_trait;
use std::collections::HashMap;
use std::io::BufRead;
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter};
use tokio::sync::mpsc;

use crate::providers::events::ProviderEvent;
use crate::providers::traits::{
    ProviderAdapter, ProviderAdapterCapabilities, ProviderAdapterError, ProviderApprovalDecision,
    ProviderKind, ProviderSendTurnInput, ProviderSession, ProviderSessionModelSwitchMode,
    ProviderSessionStartInput, ProviderThreadSnapshot, ProviderTurnStartResult,
    ProviderUserInputAnswers,
};
use crate::providers::util::{cap_event_size, shim_command};
use crate::types::{CodexDone, CodexEvent, CreateCodexRequest, SendCodexPromptRequest};

// ── Binary discovery ───────────────────────────────────────

pub fn resolve_codex_path() -> String {
    let lookup = {
        let (cmd, arg) = if cfg!(windows) {
            ("where", "codex")
        } else {
            ("which", "codex")
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
            candidates.push(format!("{}\\.local\\bin\\codex.exe", h));
            candidates.push(format!("{}\\.local\\bin\\codex.cmd", h));
        }
        if let Ok(appdata) = std::env::var("APPDATA") {
            candidates.push(format!("{}\\npm\\codex.cmd", appdata));
            candidates.push(format!("{}\\npm\\codex.exe", appdata));
        }
    } else {
        if let Some(ref h) = home {
            candidates.push(format!("{}/.local/bin/codex", h));
            candidates.push(format!("{}/.npm-global/bin/codex", h));
        }
        candidates.push("/usr/local/bin/codex".to_string());
        candidates.push("/opt/homebrew/bin/codex".to_string());
    }
    for c in &candidates {
        if std::path::Path::new(c).exists() {
            return c.clone();
        }
    }
    #[cfg(target_os = "windows")]
    return "codex.cmd".to_string();
    #[cfg(not(target_os = "windows"))]
    return "codex".to_string();
}

// ── Session state + command builder ────────────────────────

struct CodexInstance {
    child: Child,
    generation: u64,
}

static GENERATION: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

#[derive(Debug, Clone, Copy)]
enum InvokeMode<'a> {
    /// Fresh session — `codex exec --json [prompt]`.
    Fresh,
    /// Resume an existing session — `codex exec resume <id> --json [prompt]`.
    Resume(&'a str),
}

#[allow(clippy::too_many_arguments)]
fn build_command(
    mode: InvokeMode<'_>,
    cwd: &str,
    prompt: &str,
    sandbox_mode: &Option<String>,
    approval_policy: &Option<String>,
    model: &Option<String>,
    effort: &Option<String>,
    full_auto: bool,
    yolo: bool,
    skip_git_repo_check: bool,
) -> Command {
    let codex_bin = resolve_codex_path();
    let mut cmd = shim_command(&codex_bin);
    cmd.arg("exec");
    if let InvokeMode::Resume(thread_id) = mode {
        cmd.arg("resume").arg(thread_id);
    }
    cmd.arg("--json");
    if skip_git_repo_check {
        cmd.arg("--skip-git-repo-check");
    }
    if !cwd.is_empty() && cwd != "." {
        cmd.arg("-C").arg(cwd);
        cmd.current_dir(cwd);
    }

    if let Some(m) = model {
        if !m.is_empty() {
            cmd.arg("-m").arg(m);
        }
    }

    // Sandbox flag and the convenience presets are mutually exclusive in the
    // CLI: `--full-auto` and `--yolo` already imply a sandbox choice.
    if yolo {
        cmd.arg("--dangerously-bypass-approvals-and-sandbox");
    } else if full_auto {
        cmd.arg("--full-auto");
    } else if let Some(s) = sandbox_mode {
        if !s.is_empty() {
            cmd.arg("-s").arg(s);
        }
    }

    if !yolo && !full_auto {
        if let Some(p) = approval_policy {
            if !p.is_empty() {
                cmd.arg("-c").arg(format!("approval_policy={}", p));
            }
        }
    }

    if let Some(e) = effort {
        if !e.is_empty() {
            cmd.arg("-c").arg(format!("model_reasoning_effort={}", e));
        }
    }

    // Prompt is the final positional arg. NB: on Windows when shim_command
    // routes through cmd.exe, embedded newlines may be truncated. Same caveat
    // as the Claude adapter; we accept this limitation for Step 1 since the
    // most common case (single-line prompts) works fine on all platforms.
    cmd.arg(prompt);

    cmd.stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .stdin(Stdio::null());
    cmd
}

fn spawn_and_stream(
    instances: &Arc<Mutex<HashMap<String, CodexInstance>>>,
    app_handle: &AppHandle,
    session_id: String,
    mut cmd: Command,
) -> Result<(), String> {
    {
        let mut inst = instances.lock().map_err(|e| e.to_string())?;
        if let Some(mut old) = inst.remove(&session_id) {
            let _ = old.child.kill();
            let _ = old.child.wait();
            drop(inst);
            std::thread::sleep(std::time::Duration::from_millis(150));
        }
    }

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Failed to spawn codex: {}", e))?;

    let stdout = child.stdout.take().ok_or("Failed to capture stdout")?;
    let stderr_buf: Arc<Mutex<String>> = Arc::new(Mutex::new(String::new()));
    if let Some(stderr) = child.stderr.take() {
        let sid_for_stderr = session_id.clone();
        let buf = stderr_buf.clone();
        std::thread::spawn(move || {
            let reader = std::io::BufReader::new(stderr);
            for line in reader.lines().map_while(Result::ok) {
                safe_eprintln!(
                    "[codex:stderr:{}] {}",
                    &sid_for_stderr[..8.min(sid_for_stderr.len())],
                    line
                );
                if let Ok(mut b) = buf.lock() {
                    if b.len() < 4000 {
                        if !b.is_empty() {
                            b.push('\n');
                        }
                        b.push_str(&line);
                    }
                }
            }
        });
    }

    let gen = GENERATION.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let sid = session_id.clone();
    let handle = app_handle.clone();
    let instances_clone = instances.clone();

    std::thread::spawn(move || {
        safe_eprintln!("[codex] Reader thread started for {} (gen {})", sid, gen);
        let reader = std::io::BufReader::new(stdout);
        let mut had_output = false;
        for line in reader.lines() {
            match line {
                Ok(line) if line.trim().is_empty() => continue,
                Ok(line) => {
                    had_output = true;
                    let data = cap_event_size(line);
                    if let Err(e) = handle.emit(
                        "codex-event",
                        CodexEvent {
                            session_id: sid.clone(),
                            data,
                        },
                    ) {
                        safe_eprintln!("[codex] Failed to emit codex-event for {}: {}", sid, e);
                    }
                }
                Err(e) => {
                    safe_eprintln!("[codex] Reader error: {} for {}", e, sid);
                    break;
                }
            }
        }
        if !had_output {
            std::thread::sleep(std::time::Duration::from_millis(150));
            let stderr_msg = stderr_buf.lock().map(|s| s.clone()).unwrap_or_default();
            let error_msg = if stderr_msg.is_empty() {
                "Codex process exited without output. The CLI may not be installed (try `which codex`) or the prompt was rejected.".to_string()
            } else {
                stderr_msg
            };
            safe_eprintln!(
                "[codex] No stdout for {} — emitting error: {}",
                sid,
                &error_msg[..error_msg.len().min(200)]
            );
            if let Err(e) = handle.emit(
                "codex-event",
                CodexEvent {
                    session_id: sid.clone(),
                    data: serde_json::json!({
                        "type": "error",
                        "message": error_msg,
                    })
                    .to_string(),
                },
            ) {
                safe_eprintln!("[codex] Failed to emit error event for {}: {}", sid, e);
            }
        }
        safe_eprintln!("[codex] Reader thread ended for {} (gen {})", sid, gen);
        let is_current = if let Ok(mut inst) = instances_clone.lock() {
            if let Some(instance) = inst.get(&sid) {
                if instance.generation == gen {
                    inst.remove(&sid);
                    true
                } else {
                    safe_eprintln!(
                        "[codex] Stale reader gen {} != current {} for {} — skipping codex-done",
                        gen,
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
            if let Err(e) = handle.emit(
                "codex-done",
                CodexDone {
                    session_id: sid.clone(),
                },
            ) {
                safe_eprintln!("[codex] Failed to emit codex-done for {}: {}", sid, e);
            }
        }
    });

    instances.lock().map_err(|e| e.to_string())?.insert(
        session_id,
        CodexInstance {
            child,
            generation: gen,
        },
    );
    Ok(())
}

fn resolve_session_id(provided: &str) -> String {
    let trimmed = provided.trim();
    if trimmed.is_empty() {
        uuid::Uuid::new_v4().to_string()
    } else {
        trimmed.to_string()
    }
}

// ── CodexAdapter ──────────────────────────────────────────

pub struct CodexAdapter {
    instances: Arc<Mutex<HashMap<String, CodexInstance>>>,
    #[allow(dead_code)]
    capabilities: ProviderAdapterCapabilities,
}

impl CodexAdapter {
    pub fn new() -> Self {
        Self {
            instances: Arc::new(Mutex::new(HashMap::new())),
            capabilities: ProviderAdapterCapabilities {
                session_model_switch: ProviderSessionModelSwitchMode::InSession,
            },
        }
    }

    /// Spawn a fresh `codex exec --json` process. Returns the local UUID we
    /// minted (or echoed back). The Codex CLI assigns its own thread id and
    /// emits it in the first `thread.started` event — the frontend should
    /// adopt that as the canonical id for follow-up `send_prompt` calls.
    pub fn create_session(
        &self,
        app_handle: &AppHandle,
        req: CreateCodexRequest,
    ) -> Result<String, String> {
        let resolved_id = resolve_session_id(&req.session_id);
        safe_eprintln!(
            "[codex] Creating session id={} cwd={} model={:?} sandbox={:?}",
            resolved_id,
            req.cwd,
            req.model,
            req.sandbox_mode
        );
        let cmd = build_command(
            InvokeMode::Fresh,
            &req.cwd,
            &req.prompt,
            &req.sandbox_mode,
            &req.approval_policy,
            &req.model,
            &req.effort,
            req.full_auto.unwrap_or(false),
            req.yolo.unwrap_or(false),
            req.skip_git_repo_check.unwrap_or(true),
        );
        spawn_and_stream(&self.instances, app_handle, resolved_id.clone(), cmd)?;
        Ok(resolved_id)
    }

    /// Send a follow-up prompt to an existing Codex thread. `req.session_id`
    /// MUST be the Codex-assigned `thread_id` (captured from the
    /// `thread.started` event of the originating session) for the resume to
    /// succeed.
    pub fn send_prompt(
        &self,
        app_handle: &AppHandle,
        req: SendCodexPromptRequest,
    ) -> Result<(), String> {
        if req.session_id.trim().is_empty() {
            return Err("send_prompt: session_id is required for codex resume".to_string());
        }
        safe_eprintln!(
            "[codex] Resuming session {} cwd={}",
            req.session_id,
            req.cwd
        );
        let cmd = build_command(
            InvokeMode::Resume(&req.session_id),
            &req.cwd,
            &req.prompt,
            &req.sandbox_mode,
            &req.approval_policy,
            &req.model,
            &req.effort,
            req.full_auto.unwrap_or(false),
            req.yolo.unwrap_or(false),
            req.skip_git_repo_check.unwrap_or(true),
        );
        spawn_and_stream(&self.instances, app_handle, req.session_id, cmd)
    }

    pub fn cancel(&self, session_id: &str) -> Result<(), String> {
        let mut instances = self.instances.lock().map_err(|e| e.to_string())?;
        if let Some(instance) = instances.get_mut(session_id) {
            let _ = instance.child.kill();
            let _ = instance.child.wait();
            safe_eprintln!("[codex] Cancelled session {}", session_id);
        }
        Ok(())
    }

    pub fn close(&self, session_id: &str) -> Result<(), String> {
        self.cancel(session_id)
    }
}

impl Default for CodexAdapter {
    fn default() -> Self {
        Self::new()
    }
}

// ── ProviderAdapter trait impl ─────────────────────────────

#[async_trait]
impl ProviderAdapter for CodexAdapter {
    fn provider(&self) -> ProviderKind {
        ProviderKind::Codex
    }

    fn capabilities(&self) -> &ProviderAdapterCapabilities {
        &self.capabilities
    }

    async fn start_session(
        &self,
        _input: ProviderSessionStartInput,
    ) -> Result<ProviderSession, ProviderAdapterError> {
        Err(
            "CodexAdapter::start_session not wired in Step 1 — call inherent create_session"
                .to_string(),
        )
    }

    async fn send_turn(
        &self,
        _input: ProviderSendTurnInput,
    ) -> Result<ProviderTurnStartResult, ProviderAdapterError> {
        Err("CodexAdapter::send_turn not wired in Step 1 — call inherent send_prompt".to_string())
    }

    async fn interrupt_turn(
        &self,
        thread_id: &str,
        _turn_id: Option<&str>,
    ) -> Result<(), ProviderAdapterError> {
        self.cancel(thread_id)
    }

    async fn respond_to_request(
        &self,
        _thread_id: &str,
        _request_id: &str,
        _decision: ProviderApprovalDecision,
    ) -> Result<(), ProviderAdapterError> {
        // Codex approvals come through the JSON stream as `item.completed`
        // requests of type `command_execution` / etc., but `codex exec --json`
        // is non-interactive — once the approval policy is set at spawn
        // there's no way to respond mid-turn. Use `--full-auto` or
        // `--dangerously-bypass-approvals-and-sandbox` instead. Returning
        // an explicit error so callers don't silently drop replies.
        Err(
            "CodexAdapter::respond_to_request: codex exec --json runs non-interactively; \
             set approval_policy at spawn time"
                .to_string(),
        )
    }

    async fn respond_to_user_input(
        &self,
        _thread_id: &str,
        _request_id: &str,
        _answers: ProviderUserInputAnswers,
    ) -> Result<(), ProviderAdapterError> {
        Err("CodexAdapter::respond_to_user_input not implemented".to_string())
    }

    async fn stop_session(&self, thread_id: &str) -> Result<(), ProviderAdapterError> {
        self.close(thread_id)
    }

    async fn list_sessions(&self) -> Vec<ProviderSession> {
        let Ok(instances) = self.instances.lock() else {
            return Vec::new();
        };
        instances
            .keys()
            .map(|sid| {
                serde_json::json!({
                    "provider": "codex",
                    "threadId": sid,
                })
            })
            .collect()
    }

    async fn has_session(&self, thread_id: &str) -> bool {
        self.instances
            .lock()
            .map(|m| m.contains_key(thread_id))
            .unwrap_or(false)
    }

    async fn read_thread(
        &self,
        _thread_id: &str,
    ) -> Result<ProviderThreadSnapshot, ProviderAdapterError> {
        Err("CodexAdapter::read_thread not implemented".to_string())
    }

    async fn rollback_thread(
        &self,
        _thread_id: &str,
        _num_turns: u32,
    ) -> Result<ProviderThreadSnapshot, ProviderAdapterError> {
        Err("CodexAdapter::rollback_thread not implemented".to_string())
    }

    async fn stop_all(&self) -> Result<(), ProviderAdapterError> {
        let ids: Vec<String> = match self.instances.lock() {
            Ok(m) => m.keys().cloned().collect(),
            Err(_) => return Ok(()),
        };
        for sid in ids {
            let _ = self.cancel(&sid);
        }
        Ok(())
    }

    async fn stream_events(&self) -> mpsc::Receiver<ProviderEvent> {
        let (_tx, rx) = mpsc::channel(1);
        rx
    }
}
