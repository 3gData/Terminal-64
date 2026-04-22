//! Stdio MCP permission-prompt shim.
//!
//! Claude CLI's sensitive-file classifier (`.mcp.json`, `.zshrc`, `.git/*`,
//! `.claude/settings.json`, …) is bypass-immune: `--permission-mode
//! bypassPermissions`, `--dangerously-skip-permissions`, and PreToolUse
//! `permissionDecision: "allow"` hooks all fail to silence it. The ONE escape
//! hatch Anthropic exposes is `--permission-prompt-tool mcp__<server>__<tool>`:
//! when the internal check returns `{behavior:"ask", type:"safetyCheck"}`, the
//! CLI routes the decision through an MCP tool instead of the TUI prompt.
//!
//! This module is that MCP tool. When the CLI spawns the main T64 binary with
//! `T64_PERMISSION_SHIM=1`, we skip Tauri bootstrap and run a minimal stdio
//! JSON-RPC server exposing a single tool `approve`. Each `tools/call` forwards
//! the request to the main app's permission server over HTTP; the main app
//! decides (auto-allow in bypass mode, otherwise routes to the existing UI
//! permission card) and returns the verdict; we hand it back to the CLI.
//!
//! Result: sensitive-file edits succeed mid-stream in bypass mode with no
//! cancellation, no apology, no "Terminal 64 applied this for you" fallback.

use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpStream;
use std::path::Path;
use std::time::Duration;

const SHIM_ENV: &str = "T64_PERMISSION_SHIM";
const PORT_ENV: &str = "T64_SHIM_PORT";
const SECRET_ENV: &str = "T64_SHIM_SECRET";
const RUN_TOKEN_ENV: &str = "T64_SHIM_RUN_TOKEN";
const SESSION_ID_ENV: &str = "T64_SHIM_SESSION_ID";
const PERMISSION_MODE_ENV: &str = "T64_SHIM_PERMISSION_MODE";

/// Returns true when the current process was spawned as the permission shim.
pub fn is_shim_mode() -> bool {
    std::env::var(SHIM_ENV).ok().as_deref() == Some("1")
}

/// Run the stdio MCP server loop. Never returns — exits the process directly.
pub fn run_shim_from_env() -> ! {
    let port: u16 = std::env::var(PORT_ENV)
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(0);
    let secret = std::env::var(SECRET_ENV).unwrap_or_default();
    let run_token = std::env::var(RUN_TOKEN_ENV).unwrap_or_default();
    let session_id = std::env::var(SESSION_ID_ENV).unwrap_or_default();
    let permission_mode = std::env::var(PERMISSION_MODE_ENV).unwrap_or_default();

    if port == 0 || secret.is_empty() || run_token.is_empty() {
        eprintln!(
            "[t64-shim] Missing env vars (port={}, secret={}, run_token={})",
            port,
            !secret.is_empty(),
            !run_token.is_empty()
        );
        std::process::exit(2);
    }

    eprintln!(
        "[t64-shim] Started (port={}, session={})",
        port,
        &session_id[..session_id.len().min(8)]
    );

    let stdin = std::io::stdin();
    let reader = BufReader::new(stdin.lock());
    let mut stdout = std::io::stdout().lock();

    for line in reader.lines() {
        let line = match line {
            Ok(l) => l,
            Err(e) => {
                eprintln!("[t64-shim] stdin read error: {}", e);
                break;
            }
        };
        if line.trim().is_empty() {
            continue;
        }
        let msg: serde_json::Value = match serde_json::from_str(&line) {
            Ok(v) => v,
            Err(e) => {
                eprintln!(
                    "[t64-shim] bad JSON: {} ({})",
                    e,
                    line.chars().take(120).collect::<String>()
                );
                continue;
            }
        };

        // Notifications (no id) don't get a response.
        if msg.get("id").is_none() {
            // notifications/initialized etc. — ignore.
            continue;
        }

        let id = msg.get("id").cloned().unwrap_or(serde_json::Value::Null);
        let method = msg.get("method").and_then(|v| v.as_str()).unwrap_or("");

        let response = match method {
            "initialize" => serde_json::json!({
                "jsonrpc": "2.0",
                "id": id,
                "result": {
                    "protocolVersion": "2024-11-05",
                    "capabilities": { "tools": {} },
                    "serverInfo": { "name": "t64-approver", "version": "1.0.0" }
                }
            }),
            "tools/list" => serde_json::json!({
                "jsonrpc": "2.0",
                "id": id,
                "result": {
                    "tools": [{
                        "name": "approve",
                        "description": "Terminal 64 permission approver — returns {behavior:'allow'|'deny'} for tool-call requests that the Claude CLI's internal check returned as 'ask'.",
                        "inputSchema": {
                            "type": "object",
                            "properties": {
                                "tool_name": { "type": "string" },
                                "input": { "type": "object" },
                                "tool_use_id": { "type": "string" }
                            },
                            "required": ["tool_name", "input", "tool_use_id"]
                        }
                    }]
                }
            }),
            "tools/call" => {
                let name = msg
                    .pointer("/params/name")
                    .and_then(|v| v.as_str())
                    .unwrap_or("");
                if name != "approve" {
                    error_response(&id, -32601, &format!("unknown tool: {}", name))
                } else {
                    let args = msg
                        .pointer("/params/arguments")
                        .cloned()
                        .unwrap_or_default();
                    match request_decision(port, &secret, &run_token, &permission_mode, &args) {
                        Ok(decision_json) => serde_json::json!({
                            "jsonrpc": "2.0",
                            "id": id,
                            "result": {
                                "content": [{
                                    "type": "text",
                                    "text": decision_json
                                }]
                            }
                        }),
                        Err(e) => {
                            eprintln!("[t64-shim] decision error: {}", e);
                            // Fail closed: deny with an explanatory message so
                            // the CLI surfaces the problem instead of hanging.
                            let deny = serde_json::json!({
                                "behavior": "deny",
                                "message": format!("Terminal 64 permission server unreachable: {}", e)
                            });
                            serde_json::json!({
                                "jsonrpc": "2.0",
                                "id": id,
                                "result": {
                                    "content": [{ "type": "text", "text": deny.to_string() }]
                                }
                            })
                        }
                    }
                }
            }
            "shutdown" => serde_json::json!({ "jsonrpc": "2.0", "id": id, "result": {} }),
            _ => error_response(&id, -32601, &format!("method not found: {}", method)),
        };

        let line = format!("{}\n", response);
        if stdout.write_all(line.as_bytes()).is_err() {
            break;
        }
        let _ = stdout.flush();

        if method == "shutdown" {
            break;
        }
    }

    eprintln!("[t64-shim] Exiting");
    std::process::exit(0);
}

fn error_response(id: &serde_json::Value, code: i32, message: &str) -> serde_json::Value {
    serde_json::json!({
        "jsonrpc": "2.0",
        "id": id,
        "error": { "code": code, "message": message }
    })
}

/// POST the tool-call args to the main app's permission server and return the
/// raw decision JSON string (which the MCP content block will carry as text).
fn request_decision(
    port: u16,
    secret: &str,
    run_token: &str,
    permission_mode: &str,
    args: &serde_json::Value,
) -> Result<String, String> {
    let body = serde_json::json!({
        "tool_name": args.get("tool_name").and_then(|v| v.as_str()).unwrap_or(""),
        "input": args.get("input").cloned().unwrap_or(serde_json::json!({})),
        "tool_use_id": args.get("tool_use_id").and_then(|v| v.as_str()).unwrap_or(""),
        "permission_mode": permission_mode,
    })
    .to_string();

    let path = format!("/mcp-approve/{}/{}", secret, run_token);
    let request = format!(
        "POST {} HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        path, port, body.len(), body
    );

    let addr = format!("127.0.0.1:{}", port);
    let mut stream = TcpStream::connect(&addr).map_err(|e| format!("connect {}: {}", addr, e))?;
    // 5 minutes — matches the permission server's pending decision timeout.
    stream.set_read_timeout(Some(Duration::from_secs(310))).ok();
    stream.set_write_timeout(Some(Duration::from_secs(10))).ok();
    stream
        .write_all(request.as_bytes())
        .map_err(|e| format!("write: {}", e))?;

    // Read the whole response.
    let mut buf = Vec::with_capacity(4096);
    stream
        .read_to_end(&mut buf)
        .map_err(|e| format!("read: {}", e))?;
    let text = String::from_utf8_lossy(&buf);
    let body_start = text
        .find("\r\n\r\n")
        .map(|i| i + 4)
        .ok_or_else(|| "malformed HTTP response (no body)".to_string())?;
    Ok(text[body_start..].to_string())
}

/// Build the MCP config JSON that Claude CLI will consume at spawn time. The
/// shim itself is the current T64 binary re-invoked with `T64_PERMISSION_SHIM=1`.
pub fn build_mcp_config(
    binary_path: &Path,
    port: u16,
    secret: &str,
    run_token: &str,
    session_id: &str,
    permission_mode: &str,
) -> serde_json::Value {
    serde_json::json!({
        "mcpServers": {
            "t64": {
                "type": "stdio",
                "command": binary_path.to_string_lossy(),
                "args": [],
                "env": {
                    SHIM_ENV: "1",
                    PORT_ENV: port.to_string(),
                    SECRET_ENV: secret,
                    RUN_TOKEN_ENV: run_token,
                    SESSION_ID_ENV: session_id,
                    PERMISSION_MODE_ENV: permission_mode,
                }
            }
        }
    })
}
