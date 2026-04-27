import {
  buildProviderToolCall,
  getProviderToolDiff,
  getProviderToolFilePath,
  getProviderToolPaths,
} from "../contracts/providerEvents";
import type { ProviderTurnInput } from "../contracts/providerRuntime";
import {
  claudeBlockToProviderToolCall,
  claudeBlockToProviderToolResult,
} from "./claudeEventDecoder";
import {
  codexDropTurnsForKeepMessages,
  buildCodexCreateRequest,
  buildCodexSendRequest,
  promptWithCodexSeed,
} from "./providerRuntimes/openai";
import {
  codexInputChangedPaths,
  codexItemChangedPaths,
  codexItemDisplayName,
  codexItemInput,
  codexItemToProviderToolCall,
  codexItemToProviderToolResult,
} from "./codexEventDecoder";
import { decodeCodexPermission, getProviderManifest, providerSupports } from "./providers";
import { providerTurnOperation } from "./providerRuntime";
import { STORAGE_KEY, useClaudeStore } from "../stores/claudeStore";
import type { ChatMessage } from "./types";

type VerificationResult = {
  name: string;
  ok: true;
};

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(`[provider verification] ${message}`);
  }
}

function assertEqual<T>(actual: T, expected: T, message: string): void {
  assert(Object.is(actual, expected), `${message}: expected ${String(expected)}, got ${String(actual)}`);
}

function assertNoUndefinedOwnValues(value: Record<string, unknown>, label: string): void {
  for (const [key, entry] of Object.entries(value)) {
    assert(entry !== undefined, `${label}.${key} should be omitted instead of set to undefined`);
  }
}

const transcriptFixture: ChatMessage[] = [
  { id: "u1", role: "user", content: "open src/App.tsx", timestamp: 1 },
  {
    id: "a1",
    role: "assistant",
    content: "Found it.",
    timestamp: 2,
    toolCalls: [{ id: "tc1", name: "Read", input: { file_path: "src/App.tsx" } }],
  },
  { id: "u2", role: "user", content: "now edit it", timestamp: 3 },
  { id: "a2", role: "assistant", content: "Edited.", timestamp: 4 },
];

function providerInput(overrides: Partial<ProviderTurnInput> = {}): ProviderTurnInput {
  return {
    provider: "openai",
    sessionId: "session-1",
    cwd: "/repo",
    prompt: "hello",
    started: false,
    ...overrides,
  };
}

export function verifyProviderManifestDefaults(): VerificationResult {
  const anthropic = getProviderManifest("anthropic");
  const openai = getProviderManifest("openai");

  assertEqual(anthropic.defaultModel, "sonnet", "Anthropic default model");
  assertEqual(anthropic.defaultEffort, "high", "Anthropic default effort");
  assertEqual(anthropic.defaultPermission, "default", "Anthropic default permission");
  assert(anthropic.models.some((model) => model.id === anthropic.defaultModel), "Anthropic default model is listed");
  assert(anthropic.efforts.some((effort) => effort.id === anthropic.defaultEffort), "Anthropic default effort is listed");
  assert(anthropic.permissions.some((permission) => permission.id === anthropic.defaultPermission), "Anthropic default permission is listed");

  assertEqual(openai.defaultModel, "gpt-5.5", "OpenAI default model");
  assertEqual(openai.defaultEffort, "medium", "OpenAI default effort");
  assertEqual(openai.defaultPermission, "workspace", "OpenAI default permission");
  assert(openai.models.some((model) => model.id === openai.defaultModel), "OpenAI default model is listed");
  assert(openai.efforts.some((effort) => effort.id === openai.defaultEffort), "OpenAI default effort is listed");
  assert(openai.permissions.some((permission) => permission.id === openai.defaultPermission), "OpenAI default permission is listed");
  assert(providerSupports("openai", "fork"), "OpenAI manifest advertises fork support");
  assert(providerSupports("openai", "rewind"), "OpenAI manifest advertises rewind support");
  assert(!providerSupports("openai", "hookLog"), "OpenAI manifest does not expose Claude hook log");

  return { name: "provider manifest defaults", ok: true };
}

export function verifyProviderStateMigrationFixture(): VerificationResult {
  assert(typeof localStorage !== "undefined", "providerState migration fixture requires browser localStorage");

  const sessionId = "provider-verification-legacy-openai";
  const previousStorage = localStorage.getItem(STORAGE_KEY);
  const previousSessions = useClaudeStore.getState().sessions;

  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      [sessionId]: {
        sessionId,
        name: "Legacy Codex",
        cwd: "",
        draftPrompt: "draft",
        lastSeenAt: 1,
        schemaVersion: 4,
        provider: "openai",
        codexThreadId: "thread-legacy",
        selectedModel: "gpt-5.4",
        selectedEffort: "high",
        selectedCodexPermission: "yolo",
        seedTranscript: transcriptFixture.slice(0, 2),
      },
    }));
    useClaudeStore.setState({ sessions: {} });
    useClaudeStore.getState().createSession(sessionId);
    const migrated = useClaudeStore.getState().sessions[sessionId];

    assert(migrated, "legacy OpenAI metadata creates a session");
    assertEqual(migrated.providerState.provider, "openai", "legacy provider migrates into providerState");
    assertEqual(migrated.providerState.openai?.codexThreadId, "thread-legacy", "legacy Codex thread id migrates");
    assertEqual(migrated.providerState.openai?.selectedCodexPermission, "yolo", "legacy Codex permission migrates");
    assertEqual(migrated.providerState.selectedModel, "gpt-5.4", "legacy selected model migrates");
    assertEqual(migrated.providerState.selectedEffort, "high", "legacy selected effort migrates");
    assertEqual(migrated.messages.length, 2, "legacy seed transcript hydrates into visible messages");
    assertEqual(migrated.codexThreadId, migrated.providerState.openai?.codexThreadId ?? null, "compat thread mirror matches providerState");

    return { name: "providerState legacy migration", ok: true };
  } finally {
    useClaudeStore.setState({ sessions: previousSessions });
    if (previousStorage === null) {
      localStorage.removeItem(STORAGE_KEY);
    } else {
      localStorage.setItem(STORAGE_KEY, previousStorage);
    }
  }
}

export function verifyProviderRuntimeFixtures(): VerificationResult {
  assertEqual(providerTurnOperation(providerInput()), "create", "fresh provider turn creates");
  assertEqual(providerTurnOperation(providerInput({ started: true })), "send", "started provider turn sends");
  assertEqual(providerTurnOperation(providerInput({ threadId: "thread-1" })), "send", "thread-backed provider turn sends");
  assertEqual(
    providerTurnOperation(providerInput({ forkParentSessionId: "parent-1" })),
    "send",
    "forked provider turn sends through runtime fork path",
  );

  const createReq = buildCodexCreateRequest(providerInput({
    selectedModel: "gpt-5.4",
    selectedEffort: "xhigh",
    selectedCodexPermission: "workspace",
    codexCollaborationMode: "plan",
  }));
  assertEqual(createReq.session_id, "session-1", "Codex create keeps local session id");
  assertEqual(createReq.model, "gpt-5.4", "Codex create includes selected model");
  assertEqual(createReq.effort, "xhigh", "Codex create includes selected effort");
  assertEqual(createReq.sandbox_mode, "workspace-write", "Codex workspace preset maps to sandbox");
  assertEqual(createReq.approval_policy, "never", "Codex workspace preset maps to approval policy");
  assertEqual(createReq.collaboration_mode, "plan", "Codex create carries app-server collaboration mode");
  assertNoUndefinedOwnValues(createReq as unknown as Record<string, unknown>, "createReq");

  const sendReq = buildCodexSendRequest(
    providerInput({ threadId: "thread-1" }),
    createReq,
  );
  assertEqual(sendReq.thread_id, "thread-1", "Codex send includes external app-server thread id");
  assertNoUndefinedOwnValues(sendReq as unknown as Record<string, unknown>, "sendReq");

  const yoloReq = buildCodexCreateRequest(providerInput({
    selectedCodexPermission: "workspace",
    permissionOverride: "bypass_all",
  }));
  assertEqual(yoloReq.yolo, true, "Claude bypass override maps to Codex yolo request");
  assert(!Object.prototype.hasOwnProperty.call(yoloReq, "sandbox_mode"), "yolo request omits sandbox_mode");
  assert(!Object.prototype.hasOwnProperty.call(yoloReq, "approval_policy"), "yolo request omits approval_policy");

  const seededPrompt = promptWithCodexSeed("continue", transcriptFixture.slice(0, 2));
  assert(seededPrompt.includes("Prior transcript"), "Codex fork prompt includes transcript heading");
  assert(seededPrompt.includes("Tool: Read"), "Codex fork prompt includes tool call context");
  assertEqual(codexDropTurnsForKeepMessages(transcriptFixture, 2), 1, "Codex rewind/fork drops trailing user turns");
  assertEqual(codexDropTurnsForKeepMessages(transcriptFixture, 10), 0, "Codex drop-turn calculation never goes negative");

  return { name: "provider runtime create/send/fork/rewind fixtures", ok: true };
}

export function verifyCodexPermissionFixtures(): VerificationResult {
  assertEqual(decodeCodexPermission("read-only").sandbox_mode, "read-only", "read-only sandbox maps directly");
  assertEqual(decodeCodexPermission("workspace").sandbox_mode, "workspace-write", "workspace sandbox maps directly");
  assertEqual(decodeCodexPermission("workspace").approval_policy, "never", "workspace never asks");
  assertEqual(decodeCodexPermission("full-auto").full_auto, true, "full-auto maps to full_auto");
  assertEqual(decodeCodexPermission("yolo").yolo, true, "yolo maps to bypass flag");
  assertEqual(decodeCodexPermission("unknown").sandbox_mode, "workspace-write", "unknown preset falls back to workspace");
  return { name: "Codex permission request params", ok: true };
}

export function verifyProviderEventNormalizationFixtures(): VerificationResult {
  const toolCall = buildProviderToolCall({ id: "tool-1", name: "Edit", input: { file_path: "src/a.ts" } });
  assertEqual(getProviderToolFilePath(toolCall.input), "src/a.ts", "provider tool path reads file_path");

  const fileChangeItem = {
    id: "codex-file",
    item_type: "file_change",
    changes: [
      { filePath: "src/a.ts", unifiedDiff: "--- a\n+++ b", kind: { type: "modify" } },
      { path: "src/b.ts", diff: "--- c\n+++ d", kind: "create" },
    ],
  };
  const codexFileCall = codexItemToProviderToolCall(fileChangeItem);
  assert(codexFileCall, "Codex file change normalizes into a provider tool call");
  assertEqual(codexItemDisplayName(fileChangeItem), "MultiEdit", "multi-path Codex file change displays as MultiEdit");
  assertEqual(codexFileCall.name, "MultiEdit", "Codex file tool call uses normalized display name");
  assertEqual(getProviderToolPaths(codexFileCall.input).length, 2, "Codex file tool call exposes both changed paths");
  assert(getProviderToolDiff(codexFileCall.input).includes("+++ b"), "Codex unifiedDiff normalizes into provider diff");

  const shellItem = {
    id: "codex-shell",
    item_type: "custom_tool_call",
    name: "exec_command",
    arguments: { cmd: "npm run typecheck" },
    output: "ok",
    exit_code: 0,
  };
  const shellCall = codexItemToProviderToolCall(shellItem);
  assert(shellCall, "Codex exec_command normalizes into a provider tool call");
  assertEqual(shellCall.name, "Bash", "Codex raw shell tool displays as Bash");
  assertEqual(codexItemInput(shellItem).command, "npm run typecheck", "Codex shell command maps to command input");

  const failedResult = codexItemToProviderToolResult({
    id: "codex-failed",
    item_type: "command_execution",
    command: "false",
    output: "failed",
    exit_code: 1,
  });
  assert(failedResult, "Codex failed command normalizes into a provider tool result");
  assertEqual(failedResult.isError, true, "Codex non-zero exit becomes provider error result");

  assert(codexItemChangedPaths(fileChangeItem).includes("src/a.ts"), "Codex item changed paths include filePath shape");
  assert(codexInputChangedPaths({ changes: [{ path: "src/c.ts", diff: "diff" }] }).includes("src/c.ts"), "provider input paths include normalized changes");

  const claudeTool = claudeBlockToProviderToolCall({
    type: "tool_use",
    id: "claude-tool",
    name: "Read",
    input: { file_path: "src/App.tsx" },
  });
  assert(claudeTool, "Claude tool_use normalizes into a provider tool call");
  assertEqual(claudeTool.name, "Read", "Claude tool_use keeps tool name");

  const claudeResult = claudeBlockToProviderToolResult({
    type: "tool_result",
    tool_use_id: "claude-tool",
    content: [{ type: "text", text: "done" }],
    is_error: false,
  });
  assert(claudeResult, "Claude tool_result normalizes into a provider tool result");
  assertEqual(claudeResult.result, "done", "Claude text result extracts content");

  return { name: "provider event/tool normalization fixtures", ok: true };
}

export function runProviderModularityVerification(): VerificationResult[] {
  return [
    verifyProviderManifestDefaults(),
    verifyProviderRuntimeFixtures(),
    verifyCodexPermissionFixtures(),
    verifyProviderEventNormalizationFixtures(),
    verifyProviderStateMigrationFixture(),
  ];
}
