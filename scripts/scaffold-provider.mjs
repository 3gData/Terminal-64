#!/usr/bin/env node

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const args = parseArgs(process.argv.slice(2));

if (args.help || !args.providerId) {
  printHelp(args.help ? 0 : 1);
}

const providerId = normalizeProviderId(args.providerId);
const label = args.label || toTitle(providerId);
const symbol = normalizeSymbol(args.symbol || label || providerId);
const symbolCamel = toCamelIdentifier(symbol);
const runtimeExport = `${symbolCamel}Runtime`;
const decoderClass = `${symbol}LiveEventDecoder`;
const contextWindowFunction = `get${symbol}ContextWindow`;
const metadataName = `${symbol}ProviderSessionMetadata`;
const createRequestName = `Create${symbol}Request`;
const sendRequestName = `Send${symbol}PromptRequest`;
const adapterName = `${symbol}Adapter`;
const rustModule = toSnake(providerId);
const rustKind = args.rustKind || symbol;
const eventTopic = args.eventTopic || `${providerId}-event`;
const doneTopic = args.doneTopic || `${providerId}-done`;
const write = Boolean(args.write);
const force = Boolean(args.force);

const files = [
  {
    path: `src/lib/providerRuntimes/${providerId}.ts`,
    content: providerRuntimeTemplate(),
  },
  {
    path: `src/lib/${providerId}EventDecoder.ts`,
    content: eventDecoderTemplate(),
  },
  {
    path: `src-tauri/src/providers/${rustModule}.rs`,
    content: rustAdapterTemplate(),
  },
  {
    path: `docs/provider-scaffolds/${providerId}.md`,
    content: checklistTemplate(),
  },
];

if (!write) {
  console.log(`Provider scaffold dry run for "${providerId}" (${label}).`);
  console.log("");
  console.log("Files that would be created:");
  for (const file of files) {
    console.log(`  - ${file.path}`);
  }
  console.log("");
  console.log("Run with --write to create these provider-owned stubs.");
  console.log("Shared registry/contract edits are emitted into the checklist doc for coordinated application.");
  process.exit(0);
}

for (const file of files) {
  const abs = path.join(repoRoot, file.path);
  if (existsSync(abs) && !force) {
    throw new Error(`${file.path} already exists. Re-run with --force to overwrite.`);
  }
}

for (const file of files) {
  const abs = path.join(repoRoot, file.path);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, file.content);
  console.log(`created ${file.path}`);
}

function parseArgs(argv) {
  const parsed = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      parsed.help = true;
      continue;
    }
    if (arg === "--write") {
      parsed.write = true;
      continue;
    }
    if (arg === "--force") {
      parsed.force = true;
      continue;
    }
    if (arg === "--label") {
      parsed.label = readValue(argv, ++i, arg);
      continue;
    }
    if (arg === "--rust-kind") {
      parsed.rustKind = readValue(argv, ++i, arg);
      continue;
    }
    if (arg === "--symbol") {
      parsed.symbol = readValue(argv, ++i, arg);
      continue;
    }
    if (arg === "--event-topic") {
      parsed.eventTopic = readValue(argv, ++i, arg);
      continue;
    }
    if (arg === "--done-topic") {
      parsed.doneTopic = readValue(argv, ++i, arg);
      continue;
    }
    if (!parsed.providerId && !arg.startsWith("-")) {
      parsed.providerId = arg;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  return parsed;
}

function readValue(argv, index, flag) {
  const value = argv[index];
  if (!value || value.startsWith("-")) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

function printHelp(exitCode) {
  console.log(`Usage:
  node scripts/scaffold-provider.mjs <provider-id> --label <Display Name> [--write]

Examples:
  node scripts/scaffold-provider.mjs opencode --label OpenCode
  node scripts/scaffold-provider.mjs opencode --label OpenCode --write

Options:
  --write              Create scaffold files. Default is dry-run.
  --force              Overwrite generated files that already exist.
  --label <name>       Human-facing provider name used in docs/templates.
  --symbol <Name>      PascalCase identifier prefix. Defaults to --label.
  --rust-kind <Kind>   ProviderKind variant to use in the Rust adapter stub.
  --event-topic <id>   Tauri event topic for raw provider stream docs.
  --done-topic <id>    Tauri done topic for raw provider completion docs.
`);
  process.exit(exitCode);
}

function normalizeProviderId(id) {
  const normalized = id.trim().toLowerCase();
  if (!/^[a-z][a-z0-9]*$/.test(normalized)) {
    throw new Error("Provider id must be lower-case alphanumeric and start with a letter, for example opencode.");
  }
  return normalized;
}

function words(id) {
  return id.split(/[^a-zA-Z0-9]+/).filter(Boolean);
}

function toPascal(id) {
  return words(id)
    .map((word) => word.slice(0, 1).toUpperCase() + word.slice(1))
    .join("");
}

function normalizeSymbol(value) {
  const parts = String(value).trim().split(/[^a-zA-Z0-9]+/).filter(Boolean);
  const raw = parts.length > 1
    ? parts.map((part) => part.slice(0, 1).toUpperCase() + part.slice(1)).join("")
    : parts[0] || "";
  const symbolName = raw.slice(0, 1).toUpperCase() + raw.slice(1);
  if (!/^[A-Z][A-Za-z0-9]*$/.test(symbolName)) {
    throw new Error("Symbol prefix must be PascalCase, for example OpenCode.");
  }
  return symbolName;
}

function toCamelIdentifier(identifier) {
  return identifier.slice(0, 1).toLowerCase() + identifier.slice(1);
}

function toSnake(id) {
  return words(id).join("_").toLowerCase();
}

function toTitle(id) {
  return words(id)
    .map((word) => word.slice(0, 1).toUpperCase() + word.slice(1))
    .join(" ");
}

function providerRuntimeTemplate() {
  return `import {
  providerCancel,
  providerClose,
  providerCreate,
  providerSend,
} from "../tauriApi";
import type {
  ProviderRuntime,
  ProviderTurnInput,
  ProviderTurnResult,
} from "../../contracts/providerRuntime";

export interface ${createRequestName} {
  session_id: string;
  cwd: string;
  prompt: string;
  model?: string;
  effort?: string;
  permission_profile?: string;
}

export interface ${sendRequestName} extends ${createRequestName} {
  thread_id?: string;
}

declare module "../../contracts/providerIpc" {
  interface ProviderCreateRequestMap {
    ${providerId}: ${createRequestName};
  }

  interface ProviderSendRequestMap {
    ${providerId}: ${sendRequestName};
  }
}

function build${symbol}Request(input: ProviderTurnInput<"${providerId}">): ${createRequestName} {
  return {
    session_id: input.sessionId,
    cwd: input.cwd,
    prompt: input.prompt,
    ...(input.selectedModel ? { model: input.selectedModel } : {}),
    ...(input.selectedEffort ? { effort: input.selectedEffort } : {}),
    ...(input.providerPermissionId ? { permission_profile: input.providerPermissionId } : {}),
  };
}

function build${symbol}SendRequest(
  input: ProviderTurnInput<"${providerId}">,
  createReq: ${createRequestName},
): ${sendRequestName} {
  return {
    ...createReq,
    ...(input.threadId ? { thread_id: input.threadId } : {}),
  };
}

async function create(input: ProviderTurnInput<"${providerId}">): Promise<ProviderTurnResult> {
  const req = build${symbol}Request(input);
  await providerCreate({ provider: "${providerId}", req }, input.skipOpenwolf);
  return {};
}

async function send(input: ProviderTurnInput<"${providerId}">): Promise<ProviderTurnResult> {
  const createReq = build${symbol}Request(input);
  const req = build${symbol}SendRequest(input, createReq);
  await providerSend({ provider: "${providerId}", req }, input.skipOpenwolf);
  return {};
}

export const ${runtimeExport}: ProviderRuntime<"${providerId}"> = {
  provider: "${providerId}",
  create,
  send,
  cancel(sessionId) {
    return providerCancel("${providerId}", sessionId);
  },
  close(sessionId) {
    return providerClose("${providerId}", sessionId);
  },
  history: {
    source: "none",
    capabilities: {
      hydrate: false,
      fork: false,
      rewind: false,
      delete: false,
    },
  },
};
`;
}

function eventDecoderTemplate() {
  return `import type { NormalizedProviderEvent } from "../contracts/providerEvents";

export interface ${symbol}StreamEvent {
  type?: string;
  thread_id?: string;
  threadId?: string;
  text?: string;
  message?: string;
  delta?: string;
  error?: { message?: string } | string;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    total_tokens?: number;
  };
}

export function ${contextWindowFunction}(model: string | undefined | null): number {
  if (!model) return 200_000;
  return 200_000;
}

export class ${decoderClass} {
  private readonly parseErrorCounts = new Map<string, number>();

  resetSession(sessionId: string): void {
    this.parseErrorCounts.delete(sessionId);
  }

  decode(sessionId: string, data: string): NormalizedProviderEvent[] {
    let parsed: ${symbol}StreamEvent;
    try {
      parsed = JSON.parse(data) as ${symbol}StreamEvent;
    } catch (err) {
      const count = (this.parseErrorCounts.get(sessionId) || 0) + 1;
      this.parseErrorCounts.set(sessionId, count);
      console.warn("[${providerId}] Dropped malformed stream event:", data.slice(0, 200), err);
      return [];
    }
    this.parseErrorCounts.delete(sessionId);

    const type = parsed.type || "";
    if (type === "session.started" || type === "thread.started") {
      const threadId = parsed.thread_id || parsed.threadId;
      return [{
        kind: "session_started",
        ...(threadId ? { threadId } : {}),
      }];
    }

    if (type === "turn.started") {
      return [{ kind: "turn_started" }];
    }

    if (type === "content.delta") {
      const text = parsed.delta || parsed.text || "";
      return text ? [{ kind: "assistant_delta", text }] : [];
    }

    if (type === "assistant.message") {
      return [{ kind: "assistant_message", text: parsed.text || parsed.message || "" }];
    }

    if (type === "token_usage.updated" && parsed.usage?.input_tokens !== undefined) {
      return [{
        kind: "usage",
        inputTokens: parsed.usage.input_tokens,
        ...(parsed.usage.output_tokens !== undefined ? { outputTokens: parsed.usage.output_tokens } : {}),
        ...(parsed.usage.total_tokens !== undefined ? { totalTokens: parsed.usage.total_tokens } : {}),
      }];
    }

    if (type === "turn.completed") {
      this.resetSession(sessionId);
      return [{ kind: "turn_completed" }];
    }

    if (type === "turn.failed" || type === "error") {
      const message =
        (typeof parsed.error === "string" ? parsed.error : parsed.error?.message) ||
        parsed.message ||
        "${label} reported an error.";
      this.resetSession(sessionId);
      return [{ kind: "error", message }];
    }

    return [];
  }
}
`;
}

function rustAdapterTemplate() {
  return `//! ${adapterName} scaffold.
//!
//! This stub intentionally fails closed. Wire the real CLI process, event
//! emission, history support, and cleanup semantics before registering it as
//! a production provider.

use async_trait::async_trait;
use serde_json::Value as JsonValue;
use tauri::AppHandle;

use crate::providers::traits::{
    ProviderAdapter, ProviderAdapterCapabilities, ProviderAdapterError, ProviderApprovalDecision,
    ProviderCommandAdapter, ProviderCreateSessionRequest, ProviderHistoryCapabilities,
    ProviderKind, ProviderSendPromptRequest, ProviderSendTurnInput, ProviderSession,
    ProviderSessionModelSwitchMode, ProviderSessionStartInput, ProviderThreadSnapshot,
    ProviderTurnStartResult, ProviderUserInputAnswers,
};

pub struct ${adapterName} {
    capabilities: ProviderAdapterCapabilities,
}

impl ${adapterName} {
    pub fn new() -> Self {
        Self {
            capabilities: ProviderAdapterCapabilities {
                session_model_switch: ProviderSessionModelSwitchMode::Unsupported,
                history: ProviderHistoryCapabilities::NONE,
            },
        }
    }
}

impl Default for ${adapterName} {
    fn default() -> Self {
        Self::new()
    }
}

fn not_implemented(operation: &str) -> ProviderAdapterError {
    format!("${label} provider scaffold has no {} implementation yet", operation)
}

fn request_session_id(payload: &JsonValue) -> Result<String, ProviderAdapterError> {
    payload
        .get("session_id")
        .and_then(JsonValue::as_str)
        .filter(|session_id| !session_id.trim().is_empty())
        .map(ToOwned::to_owned)
        .ok_or_else(|| "missing required field 'session_id'".to_string())
}

impl ProviderCommandAdapter for ${adapterName} {
    fn create_session(
        &self,
        _app_handle: &AppHandle,
        req: ProviderCreateSessionRequest,
    ) -> Result<String, ProviderAdapterError> {
        let session_id = request_session_id(&req.payload)?;
        Err(format!("{}: {}", session_id, not_implemented("create_session")))
    }

    fn send_prompt(
        &self,
        _app_handle: &AppHandle,
        req: ProviderSendPromptRequest,
    ) -> Result<(), ProviderAdapterError> {
        let _session_id = request_session_id(&req.payload)?;
        // Live provider streams should construct ProviderRuntimeEvent values and
        // emit them with crate::providers::emit_provider_runtime_event().
        Err(not_implemented("send_prompt"))
    }

    fn cancel_session(&self, _session_id: &str) -> Result<(), ProviderAdapterError> {
        Err(not_implemented("cancel_session"))
    }

    fn close_session(&self, _session_id: &str) -> Result<(), ProviderAdapterError> {
        Err(not_implemented("close_session"))
    }
}

#[async_trait]
impl ProviderAdapter for ${adapterName} {
    fn provider(&self) -> ProviderKind {
        ProviderKind::${rustKind}
    }

    fn capabilities(&self) -> &ProviderAdapterCapabilities {
        &self.capabilities
    }

    async fn start_session(
        &self,
        _input: ProviderSessionStartInput,
    ) -> Result<ProviderSession, ProviderAdapterError> {
        Err(not_implemented("start_session"))
    }

    async fn send_turn(
        &self,
        _input: ProviderSendTurnInput,
    ) -> Result<ProviderTurnStartResult, ProviderAdapterError> {
        Err(not_implemented("send_turn"))
    }

    async fn interrupt_turn(
        &self,
        _thread_id: &str,
        _turn_id: Option<&str>,
    ) -> Result<(), ProviderAdapterError> {
        Err(not_implemented("interrupt_turn"))
    }

    async fn respond_to_request(
        &self,
        _thread_id: &str,
        _request_id: &str,
        _decision: ProviderApprovalDecision,
    ) -> Result<(), ProviderAdapterError> {
        Err(not_implemented("respond_to_request"))
    }

    async fn respond_to_user_input(
        &self,
        _thread_id: &str,
        _request_id: &str,
        _answers: ProviderUserInputAnswers,
    ) -> Result<(), ProviderAdapterError> {
        Err(not_implemented("respond_to_user_input"))
    }

    async fn stop_session(&self, _thread_id: &str) -> Result<(), ProviderAdapterError> {
        Err(not_implemented("stop_session"))
    }

    async fn list_sessions(&self) -> Vec<ProviderSession> {
        Vec::new()
    }

    async fn has_session(&self, _thread_id: &str) -> bool {
        false
    }

    async fn read_thread(
        &self,
        _thread_id: &str,
    ) -> Result<ProviderThreadSnapshot, ProviderAdapterError> {
        Err(not_implemented("read_thread"))
    }

    async fn rollback_thread(
        &self,
        _thread_id: &str,
        _num_turns: u32,
    ) -> Result<ProviderThreadSnapshot, ProviderAdapterError> {
        Err(not_implemented("rollback_thread"))
    }

    async fn stop_all(&self) -> Result<(), ProviderAdapterError> {
        Ok(())
    }

}
`;
}

function checklistTemplate() {
  const providerKindSnippet = rustKind === "OpenCode"
    ? "// ProviderKind::OpenCode already exists in the current backend."
    : `// providers/traits.rs
pub enum ProviderKind {
    ClaudeAgent,
    Codex,
    Cursor,
    OpenCode,
    ${rustKind},
}`;
  const providerKindMappingNote = rustKind === "OpenCode"
    ? `Confirm \`provider_kind_from_frontend_id\` maps \`${providerId}\` to \`ProviderKind::OpenCode\`; the current backend already handles the \`opencode\` alias.`
    : `Also update \`provider_kind_from_frontend_id\` so the frontend id
\`${providerId}\` maps to \`ProviderKind::${rustKind}\`.`;
  return `# ${label} Provider Scaffold

Generated by \`scripts/scaffold-provider.mjs\`.

This checklist is intentionally separate from the scaffolded provider-owned
files. Apply the shared edits after coordinating in the Terminal 64 MCP team
chat, because these files are common conflict points during provider work.

## Generated Files

- \`src/lib/providerRuntimes/${providerId}.ts\`
- \`src/lib/${providerId}EventDecoder.ts\`
- \`src-tauri/src/providers/${rustModule}.rs\`

## 1. Manifest Entry

File: \`src/lib/providers.ts\`

- Add \`"${providerId}"\` to \`ProviderId\`.
- Add model, effort, and permission arrays.
- Add a \`${providerId}\` entry to \`PROVIDER_REGISTRY\`.

\`\`\`ts
export type ProviderId = "anthropic" | "openai" | "${providerId}";

const ${providerId.toUpperCase()}_MODELS: ModelOption[] = [
  { id: "default", label: "Default" },
];

const ${providerId.toUpperCase()}_EFFORTS: EffortOption[] = [
  { id: "medium", label: "Medium" },
];

const ${providerId.toUpperCase()}_PERMISSIONS: PermissionOption[] = [
  { id: "default", label: "Default", color: "#89b4fa", desc: "Provider default" },
];

${providerId}: {
  id: "${providerId}",
  ui: {
    label: "${label}",
    shortLabel: "${label}",
    brandTitle: "${label}",
    emptyStateLabel: "${label}",
    defaultSessionName: "${label}",
    modelMenuLabel: "Model",
    effortMenuLabel: "Effort",
    inputPermissionSuffix: "permissions",
  },
  capabilities: {
    mcp: false,
    plan: false,
    fork: false,
    rewind: false,
    images: false,
    hookLog: false,
    nativeSlashCommands: false,
    compact: false,
  },
  delegation: {
    mcpTransport: "env",
    skipOpenwolf: "always",
    noSessionPersistence: false,
    skipGitRepoCheck: true,
    childRuntime: {
      permissionPreset: "selected",
    },
  },
  permissionControl: {
    persistence: "provider-state",
  },
  history: {
    source: "none",
    hydrateFailureLabel: "${label}",
  },
  controls: [
    {
      id: "model",
      label: "Model",
      kind: "select",
      scope: "topbar",
      defaultValue: "default",
      options: ${providerId.toUpperCase()}_MODELS,
      legacySlot: "model",
    },
    {
      id: "effort",
      label: "Effort",
      kind: "select",
      scope: "topbar",
      defaultValue: "medium",
      options: ${providerId.toUpperCase()}_EFFORTS,
      legacySlot: "effort",
    },
    {
      id: "permission",
      label: "Permissions",
      kind: "select",
      scope: "composer",
      defaultValue: "default",
      options: ${providerId.toUpperCase()}_PERMISSIONS,
      inputSuffix: "permissions",
      legacySlot: "permission",
    },
  ],
},
\`\`\`

## 2. Frontend Runtime Registry

File: \`src/lib/providerRuntime.ts\`

\`\`\`ts
import { ${runtimeExport} } from "./providerRuntimes/${providerId}";

const PROVIDER_RUNTIMES = {
  anthropic: anthropicRuntime,
  openai: openaiRuntime,
  ${providerId}: ${runtimeExport},
} satisfies Record<ProviderId, ProviderRuntime>;
\`\`\`

The generated manifest/runtime starts with \`history.source: "none"\` and
unsupported history capabilities. Change the source only when the provider owns
durable history or intentionally stores a local transcript, and flip each
capability only when the frontend runtime and backend adapter both implement
that operation.

## 3. Event Decoder Wiring

Files: \`src/lib/providerEventIngestion.ts\` and, for backend payload typing,
\`src/lib/tauriApi.ts\` / \`src/lib/types.ts\`.

Preferred path: construct the Rust \`ProviderRuntimeEvent\` envelope and emit it
with \`crate::providers::emit_provider_runtime_event()\`. That helper sends the
shared backend \`provider-event\` payload with \`provider\`, \`sessionId\`, raw
\`data\`, and typed \`event\`. The frontend \`subscribeProviderEventIngestion()\`
already listens to \`onProviderEvent\`; new providers should add only the
decoder/context-window entries there.

Legacy fallback topics, only if the provider cannot emit \`provider-event\` yet:

- \`${eventTopic}\`
- \`${doneTopic}\`

\`\`\`ts
import { ${decoderClass}, ${contextWindowFunction} } from "./${providerId}EventDecoder";

const contextWindowResolvers = {
  // existing providers...
  ${providerId}: ${contextWindowFunction},
};

const ${symbolCamel}Decoder = new ${decoderClass}();
const decoders = {
  // existing providers...
  ${providerId}: ${symbolCamel}Decoder,
};
\`\`\`

If using legacy fallback topics, add listener wrappers in \`tauriApi.ts\` and
route those payloads through the same decoder:

\`\`\`ts
// Subscribe to \`${eventTopic}\`, decode raw payloads, and emit
// { type: "event", provider: "${providerId}", sessionId, event }.
// Reset the decoder and emit { type: "done", ... } on \`${doneTopic}\`.
\`\`\`

## 4. Provider Metadata Map

File: \`src/stores/claudeStore.ts\`

\`\`\`ts
export interface ${metadataName} {
  threadId: string | null;
  permissionProfile: string | null;
}

export interface ProviderSessionMetadataRegistry {
  anthropic: Record<string, never>;
  openai: OpenAiProviderSessionMetadata;
  ${providerId}: ${metadataName};
}
\`\`\`

Add a parser beside \`openAiMetadataFromUnknown\`, normalize it inside
\`providerMetadataFromUnknown\`, and add a typed helper if call sites need one.
Keep provider-owned state under
\`providerState.providerMetadata.${providerId}\`; do not add new flat
\`ClaudeSession\` mirrors unless there is a compatibility reason.

## 5. Backend Adapter Wiring

Files: \`src-tauri/src/providers/mod.rs\`, \`src-tauri/src/providers/traits.rs\`,
and \`src-tauri/src/lib.rs\`.

\`\`\`rust
// providers/mod.rs
pub mod ${rustModule};
pub use ${rustModule}::${adapterName};

${providerKindSnippet}

// lib.rs setup
let ${toSnake(providerId)}_adapter = Arc::new(${adapterName}::new());
registry.register(
    ProviderKind::${rustKind},
    ${toSnake(providerId)}_adapter.clone() as Arc<dyn providers::ProviderAdapter>,
);
\`\`\`

${providerKindMappingNote}

## 6. Verification Fixture Entries

File: \`src/lib/providerModularity.verification.ts\`

- Move the synthetic future-provider sentinel to a different id if
  \`${providerId}\` replaces the current \`opencode\` fixture.
- Add manifest default assertions for \`${providerId}\`.
- Add runtime request-shaping assertions for \`${runtimeExport}\` or its
  exported request builders.
- Add event decoder assertions for representative raw stream events.
- Add metadata migration assertions for
  \`providerMetadata.${providerId}\`.

\`\`\`ts
const ${symbolCamel}Manifest = getProviderManifest("${providerId}");
assertEqual(${symbolCamel}Manifest.defaultModel, "default", "${label} default model");
assert(!providerSupports("${providerId}", "rewind"), "${label} starts with rewind disabled");
\`\`\`

## 7. Verification Commands

\`\`\`bash
npm run typecheck
npm run build
cd src-tauri && cargo fmt && cargo check
\`\`\`

Run \`cargo clippy --all-targets -- -D warnings\` once the backend adapter
has real process/event code.
`;
}
