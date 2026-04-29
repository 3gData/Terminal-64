import {
  buildProviderToolCall,
  getProviderToolDiff,
  getProviderToolFilePath,
  getProviderToolPaths,
} from "../contracts/providerEvents";
import type { ProviderHistoryCapability, ProviderRuntime, ProviderTurnInput } from "../contracts/providerRuntime";
import {
  claudeBlockToProviderToolCall,
  claudeBlockToProviderToolResult,
} from "./claudeEventDecoder";
import {
  buildDelegationChildProviderTurnInput,
  buildDelegationMcpEnv,
  getDelegationMcpTransport,
  resolveDelegationChildRuntimeSettings,
} from "./delegationChildRuntime";
import {
  buildDelegationChildSpawnPlan,
  buildDelegationPlanRequest,
  parseDelegateCommand,
  parseDelegationStartFromMessage,
} from "./delegationWorkflow";
import {
  CODEX_MAX_TURN_PROMPT_CHARS,
  codexPermissionForOverride,
  codexDropTurnsForKeepMessages,
  buildCodexCreateRequest,
  buildCodexSendRequest,
  promptWithCodexSeed,
} from "./providerRuntimes/openai";
import { buildCursorRequest } from "./providerRuntimes/cursor";
import { CursorLiveEventDecoder } from "./cursorEventDecoder";
import {
  codexInputChangedPaths,
  codexItemChangedPaths,
  codexItemDisplayName,
  codexItemInput,
  codexItemToProviderToolCall,
  codexItemToProviderToolResult,
} from "./codexEventDecoder";
import {
  decodeCodexPermission,
  getProviderHistoryPolicy,
  getProviderManifest,
  isProviderId,
  PROVIDER_IDS,
  providerPersistsLocalTranscript,
  providerSupports,
  type ProviderId,
  type ProviderManifest,
} from "./providers";
import {
  cancelProviderSession,
  closeProviderSession,
  deleteProviderHistory,
  getProviderRuntime,
  hydrateProviderHistory,
  prepareProviderFork,
  prepareProviderTurnInput,
  providerHistorySource,
  providerHistorySupports,
  providerTurnOperation,
  runProviderTurn,
  truncateProviderHistory,
} from "./providerRuntime";
import {
  getDefaultProviderPermissionId,
  getNextProviderPermissionId,
  getProviderPermissionInputPresentation,
  getProviderPermissionOption,
  isProviderPermissionId,
  permissionModeFromProviderPermission,
} from "./providerPermissions";
import {
  getProviderSessionMetadata,
  getOpenAiProviderSessionMetadata,
  getProviderPermissionId,
  resolveSessionProviderState,
  resolveProviderSessionMetadata,
  STORAGE_KEY,
  flushSave,
  useClaudeStore,
  type ProviderSessionState,
} from "../stores/claudeStore";
import type { CreateCodexRequest, ProviderCreateRequest, ProviderSendRequest } from "../contracts/providerIpc";
import type { ChatMessage } from "./types";

type VerificationResult = {
  name: string;
  ok: true;
};

type FutureProviderId = ProviderId | "opencode";
type FutureProviderManifest = Omit<ProviderManifest, "id"> & { id: FutureProviderId };
type FutureProviderRuntime = Omit<ProviderRuntime, "provider"> & { provider: FutureProviderId };
type FutureProviderSessionState = Omit<ProviderSessionState, "provider" | "providerMetadata" | "providerPermissions"> & {
  provider: FutureProviderId;
  providerMetadata: ProviderSessionState["providerMetadata"] & {
    opencode?: {
      threadId: string | null;
      permissionProfile: string | null;
    };
  };
  providerPermissions: ProviderSessionState["providerPermissions"] & {
    opencode?: string | null;
  };
};
type FutureProviderCreateRequest =
  | ProviderCreateRequest
  | {
    provider: "opencode";
    req: {
      session_id: string;
      cwd: string;
      prompt: string;
      client_profile: "stub";
    };
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

const futureProviderStubManifest = {
  id: "opencode",
  ui: {
    label: "OpenCode",
    shortLabel: "OpenCode",
    brandTitle: "OpenCode",
    emptyStateLabel: "OpenCode",
    defaultSessionName: "OpenCode",
    modelMenuLabel: "Model",
    effortMenuLabel: "Effort",
    inputPermissionSuffix: "profile",
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
    planner: {
      permissionOverride: "inherit",
    },
    childRuntime: {
      permissionPreset: "selected",
    },
  },
  permissionControl: {
    persistence: "provider-state",
  },
  history: {
    source: "none",
    hydrateFailureLabel: "OpenCode",
  },
  controls: {
    model: { id: "model", label: "Model" },
    effort: { id: "effort", label: "Effort" },
    permission: { id: "permission", label: "Profile", inputSuffix: "profile" },
  },
  models: [{ id: "stub-model", label: "Stub Model" }],
  efforts: [{ id: "stub-effort", label: "Stub Effort" }],
  permissions: [{ id: "stub", label: "Stub", color: "#89b4fa", desc: "Not implemented" }],
  defaultModel: "stub-model",
  defaultEffort: "stub-effort",
  defaultPermission: "stub",
} satisfies FutureProviderManifest;

function unsupportedFutureProvider(provider: FutureProviderId, operation: string): Error {
  return new Error(`Provider ${provider} has no ${operation} runtime binding`);
}

function createUnsupportedFutureRuntime(provider: FutureProviderId): FutureProviderRuntime {
  return {
    provider,
    create: async () => {
      throw unsupportedFutureProvider(provider, "create");
    },
    send: async () => {
      throw unsupportedFutureProvider(provider, "send");
    },
    cancel: async () => {
      throw unsupportedFutureProvider(provider, "cancel");
    },
    close: async () => {
      throw unsupportedFutureProvider(provider, "close");
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
}

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

const providerLifecycleOperations = ["create", "send", "cancel", "close"] as const;
const providerHistoryCapabilities: ProviderHistoryCapability[] = ["hydrate", "fork", "rewind", "delete"];
type ProviderHistoryHandlerName = "hydrate" | "fork" | "rewind" | "deleteHistory";
const providerHistoryHandlerNames = {
  hydrate: "hydrate",
  fork: "fork",
  rewind: "rewind",
  delete: "deleteHistory",
} satisfies Record<ProviderHistoryCapability, ProviderHistoryHandlerName>;

export function verifyProviderManifestDefaults(): VerificationResult {
  const anthropic = getProviderManifest("anthropic");
  const openai = getProviderManifest("openai");
  const cursor = getProviderManifest("cursor");

  assertEqual(anthropic.defaultModel, "sonnet", "Anthropic default model");
  assertEqual(anthropic.defaultEffort, "high", "Anthropic default effort");
  assertEqual(anthropic.defaultPermission, "default", "Anthropic default permission");
  assert(anthropic.models.some((model) => model.id === anthropic.defaultModel), "Anthropic default model is listed");
  assert(anthropic.efforts.some((effort) => effort.id === anthropic.defaultEffort), "Anthropic default effort is listed");
  assert(anthropic.permissions.some((permission) => permission.id === anthropic.defaultPermission), "Anthropic default permission is listed");
  assertEqual(anthropic.delegation.mcpTransport, "temp-config", "Anthropic delegation MCP transport is manifest-owned");
  assertEqual(anthropic.delegation.skipOpenwolf, "inherit", "Anthropic delegation inherits OpenWolf setting");
  assertEqual(anthropic.delegation.planner.permissionOverride, "inherit", "Anthropic delegation planner inherits explicit overrides");
  assertEqual(
    anthropic.delegation.childRuntime.permissionPreset,
    "bypass_all",
    "Anthropic delegation metadata records bypass permission",
  );
  assertEqual(anthropic.permissionControl.persistence, "provider-state", "Anthropic permission control uses provider state");
  assertEqual(
    anthropic.permissionControl.skipPermissionId,
    "bypass_all",
    "Anthropic skip-permissions preset is manifest-owned",
  );
  assertEqual(anthropic.history.source, "claude-jsonl", "Anthropic history source is manifest-owned");
  assertEqual(getProviderHistoryPolicy("anthropic").source, "claude-jsonl", "Anthropic history policy helper uses manifest source");
  assert(!providerPersistsLocalTranscript("anthropic"), "Anthropic does not persist local transcripts");

  assertEqual(openai.defaultModel, "gpt-5.5", "OpenAI default model");
  assertEqual(openai.defaultEffort, "medium", "OpenAI default effort");
  assertEqual(openai.defaultPermission, "workspace", "OpenAI default permission");
  assert(openai.models.some((model) => model.id === openai.defaultModel), "OpenAI default model is listed");
  assert(openai.efforts.some((effort) => effort.id === openai.defaultEffort), "OpenAI default effort is listed");
  assert(openai.permissions.some((permission) => permission.id === openai.defaultPermission), "OpenAI default permission is listed");
  assertEqual(openai.delegation.mcpTransport, "env", "OpenAI delegation MCP transport is manifest-owned");
  assertEqual(openai.delegation.skipOpenwolf, "always", "OpenAI delegation always skips OpenWolf bootstrap");
  assertEqual(openai.delegation.planner.permissionOverride, "inherit", "OpenAI delegation planner inherits explicit overrides");
  assertEqual(
    openai.delegation.childRuntime.permissionPreset,
    "selected",
    "OpenAI delegation metadata records selected permission preset",
  );
  assertEqual(openai.permissionControl.persistence, "provider-state", "OpenAI permission control uses provider state");
  assertEqual(openai.history.source, "codex-rollout", "OpenAI history source is manifest-owned");
  assert(!providerPersistsLocalTranscript("openai"), "OpenAI does not persist local transcripts");
  assert(providerSupports("openai", "fork"), "OpenAI manifest advertises fork support");
  assert(providerSupports("openai", "rewind"), "OpenAI manifest advertises rewind support");
  assert(!providerSupports("openai", "hookLog"), "OpenAI manifest does not expose Claude hook log");

  assertEqual(cursor.defaultModel, "composer-2-fast", "Cursor default model");
  assertEqual(cursor.defaultEffort, "default", "Cursor default effort");
  assertEqual(cursor.defaultPermission, "default", "Cursor default permission");
  assert(cursor.models.some((model) => model.id === cursor.defaultModel), "Cursor default model is listed");
  assert(cursor.efforts.some((effort) => effort.id === cursor.defaultEffort), "Cursor default effort is listed");
  assert(cursor.permissions.some((permission) => permission.id === cursor.defaultPermission), "Cursor default permission is listed");
  assertEqual(cursor.delegation.mcpTransport, "env", "Cursor delegation MCP transport is manifest-owned");
  assertEqual(cursor.delegation.skipOpenwolf, "always", "Cursor delegation skips OpenWolf bootstrap");
  assertEqual(cursor.delegation.planner.permissionOverride, "bypass_all", "Cursor delegation planner uses manifest-owned force mode");
  assertEqual(cursor.permissionControl.persistence, "provider-state", "Cursor permission control uses provider state");
  assertEqual(cursor.history.source, "local-transcript", "Cursor local transcript source is manifest-owned");
  assert(providerPersistsLocalTranscript("cursor"), "Cursor persists local transcript by manifest history source");
  assert(!providerSupports("cursor", "fork"), "Cursor manifest fails closed on fork until history support exists");
  assert(!providerSupports("cursor", "rewind"), "Cursor manifest fails closed on rewind until history support exists");

  return { name: "provider manifest defaults", ok: true };
}

export function verifyProviderStateMigrationFixture(): VerificationResult {
  assert(typeof localStorage !== "undefined", "providerState migration fixture requires browser localStorage");

  const sessionId = "provider-verification-legacy-openai";
  const stateSessionId = "provider-verification-state-openai";
  const cursorSessionId = "provider-verification-cursor-local";
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
      [stateSessionId]: {
        sessionId: stateSessionId,
        name: "Provider State Wins",
        cwd: "",
        draftPrompt: "",
        lastSeenAt: 2,
        schemaVersion: 5,
        providerState: {
          provider: "openai",
          providerLocked: true,
          selectedModel: "gpt-5.5",
          selectedEffort: "medium",
          seedTranscript: null,
          providerMetadata: {
            openai: {
              codexThreadId: "thread-provider-state",
              selectedCodexPermission: "workspace",
            },
          },
        },
        provider: "anthropic",
        codexThreadId: "thread-legacy-mirror",
        selectedModel: "sonnet",
        selectedEffort: "high",
        selectedCodexPermission: "yolo",
      },
      [cursorSessionId]: {
        sessionId: cursorSessionId,
        name: "Cursor Local",
        cwd: "",
        draftPrompt: "",
        lastSeenAt: 3,
        schemaVersion: 6,
        providerState: {
          provider: "cursor",
          providerLocked: true,
          selectedModel: "composer-2-fast",
          selectedEffort: "default",
          seedTranscript: null,
          providerMetadata: {},
        },
        provider: "cursor",
        providerLocked: true,
        localTranscript: transcriptFixture.slice(0, 2),
      },
    }));
    useClaudeStore.setState({ sessions: {} });
    useClaudeStore.getState().createSession(sessionId);
    useClaudeStore.getState().createSession(stateSessionId);
    useClaudeStore.getState().createSession(cursorSessionId);
    const migrated = useClaudeStore.getState().sessions[sessionId];
    const stateBacked = useClaudeStore.getState().sessions[stateSessionId];
    const cursorBacked = useClaudeStore.getState().sessions[cursorSessionId];

    assert(migrated, "legacy OpenAI metadata creates a session");
    assertEqual(migrated.providerState.provider, "openai", "legacy provider migrates into providerState");
    assertEqual(migrated.providerState.providerLocked, true, "legacy saved metadata locks migrated provider");
    assertEqual(migrated.providerLocked, true, "legacy provider lock mirror migrates");
    const migratedOpenAi = getOpenAiProviderSessionMetadata(migrated.providerState);
    assertEqual(migratedOpenAi?.codexThreadId, "thread-legacy", "legacy Codex thread id migrates");
    assertEqual(getProviderPermissionId(migrated.providerState, "openai"), "yolo", "legacy Codex permission migrates");
    assertEqual(migrated.providerState.selectedModel, "gpt-5.4", "legacy selected model migrates");
    assertEqual(migrated.providerState.selectedEffort, "high", "legacy selected effort migrates");
    assertEqual(migrated.messages.length, 2, "legacy seed transcript hydrates into visible messages");
    assertEqual(migrated.codexThreadId, migratedOpenAi?.codexThreadId ?? null, "compat thread mirror matches providerState");

    assert(stateBacked, "schema v5 metadata creates a providerState-backed session");
    assertEqual(stateBacked.providerState.provider, "openai", "providerState provider wins over stale flat provider");
    assertEqual(stateBacked.providerState.providerLocked, true, "providerState lock flag wins over saved metadata");
    assertEqual(stateBacked.providerLocked, true, "provider lock mirror follows providerState");
    const stateBackedOpenAi = getOpenAiProviderSessionMetadata(stateBacked.providerState);
    assertEqual(stateBackedOpenAi?.codexThreadId, "thread-provider-state", "providerState thread id wins over stale flat mirror");
    assertEqual(getProviderPermissionId(stateBacked.providerState, "openai"), "workspace", "providerState permission wins over stale flat mirror");
    assertEqual(stateBacked.providerState.selectedModel, "gpt-5.5", "providerState selected model wins over stale flat mirror");

    assert(cursorBacked, "Cursor local transcript metadata creates a session");
    assertEqual(cursorBacked.providerState.provider, "cursor", "Cursor provider state hydrates from metadata");
    assertEqual(cursorBacked.messages.length, 2, "Cursor local transcript hydrates into visible messages");
    useClaudeStore.getState().addUserMessage(cursorSessionId, "persist this");
    useClaudeStore.getState().finalizeAssistantMessage(cursorSessionId, "persisted");
    flushSave();
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}") as Record<string, { localTranscript?: ChatMessage[] }>;
    const savedCursorTranscript = saved[cursorSessionId]?.localTranscript ?? [];
    assertEqual(savedCursorTranscript.length, 4, "Cursor transcript writes back to metadata");
    assertEqual(savedCursorTranscript[3]?.content, "persisted", "Cursor assistant message persists locally");
    assertEqual(saved[sessionId]?.localTranscript, undefined, "OpenAI transcript stays provider-owned after metadata save");
    assertEqual(saved[stateSessionId]?.localTranscript, undefined, "Provider-state OpenAI transcript stays out of local metadata");

    const hotReloadFallback = resolveSessionProviderState({
      provider: "openai",
      providerLocked: true,
      codexThreadId: "thread-hot-reload",
      selectedModel: "gpt-5.4-mini",
      selectedEffort: "low",
      selectedCodexPermission: "full-auto",
      seedTranscript: transcriptFixture.slice(0, 1),
    });
    assertEqual(hotReloadFallback.provider, "openai", "hot-reloaded flat provider falls back into providerState");
    assertEqual(hotReloadFallback.providerLocked, true, "hot-reloaded flat provider lock falls back into providerState");
    const hotReloadFallbackOpenAi = getOpenAiProviderSessionMetadata(hotReloadFallback);
    assertEqual(hotReloadFallbackOpenAi?.codexThreadId, "thread-hot-reload", "hot-reloaded flat thread id falls back into providerState");
    assertEqual(getProviderPermissionId(hotReloadFallback, "openai"), "full-auto", "hot-reloaded flat permission falls back into providerState");

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

export function verifyProviderPickerLockFixtures(): VerificationResult {
  assert(typeof localStorage !== "undefined", "provider picker fixture requires browser localStorage");

  const previousStorage = localStorage.getItem(STORAGE_KEY);
  const previousSessions = useClaudeStore.getState().sessions;
  const store = useClaudeStore.getState();

  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      "picker-legacy-openai": {
        sessionId: "picker-legacy-openai",
        name: "Legacy OpenAI",
        cwd: "",
        draftPrompt: "",
        lastSeenAt: 1,
        schemaVersion: 4,
        provider: "openai",
        codexThreadId: "thread-legacy-picker",
        selectedModel: "gpt-5.4",
        selectedEffort: "high",
        selectedCodexPermission: "workspace",
      },
      "picker-saved-openai": {
        sessionId: "picker-saved-openai",
        name: "Saved OpenAI",
        cwd: "",
        draftPrompt: "",
        lastSeenAt: 2,
        schemaVersion: 5,
        providerState: {
          provider: "openai",
          providerLocked: true,
          selectedModel: "gpt-5.5",
          selectedEffort: "medium",
          seedTranscript: null,
          providerMetadata: {
            openai: {
              codexThreadId: "thread-saved-picker",
              selectedCodexPermission: "full-auto",
            },
          },
        },
      },
    }));
    useClaudeStore.setState({ sessions: {} });

    store.createSession("picker-blank", undefined, true);
    let blank = useClaudeStore.getState().sessions["picker-blank"];
    assert(blank, "blank user-created session exists");
    assertEqual(blank.providerState.provider, "anthropic", "blank user-created session defaults to Claude");
    assertEqual(blank.providerState.providerLocked, false, "blank user-created session starts provider-unlocked");

    assertEqual(store.switchProviderBeforeStart("picker-blank", "openai"), true, "blank session can switch to OpenAI before first send");
    blank = useClaudeStore.getState().sessions["picker-blank"];
    assert(blank, "switched blank session still exists");
    const openaiManifest = getProviderManifest("openai");
    assertEqual(blank.providerState.provider, "openai", "pre-send provider picker writes providerState provider");
    assertEqual(blank.provider, "openai", "pre-send provider picker writes compatibility provider mirror");
    assertEqual(blank.providerState.providerLocked, false, "pre-send provider switch keeps session unlocked");
    assertEqual(blank.providerState.selectedModel, openaiManifest.defaultModel, "pre-send provider switch resets default model");
    assertEqual(blank.providerState.selectedEffort, openaiManifest.defaultEffort, "pre-send provider switch resets default effort");
    assertEqual(getProviderPermissionId(blank.providerState, "openai"), openaiManifest.defaultPermission, "pre-send provider switch resets provider permission");
    assertEqual(
      providerTurnOperation(providerInput({
        provider: blank.providerState.provider,
        started: blank.hasBeenStarted && blank.promptCount > 0,
        selectedModel: blank.providerState.selectedModel,
        selectedEffort: blank.providerState.selectedEffort,
        providerPermissionId: getProviderPermissionId(blank.providerState, "openai"),
      })),
      "create",
      "first send from provider-picked blank session routes through create for selected provider",
    );

    store.addUserMessage("picker-blank", "hello");
    blank = useClaudeStore.getState().sessions["picker-blank"];
    assert(blank, "blank session survives first user message");
    assertEqual(blank.providerState.providerLocked, true, "first user message locks selected provider");
    assertEqual(store.switchProviderBeforeStart("picker-blank", "anthropic"), false, "first-send-locked session rejects later provider switch");
    assertEqual(useClaudeStore.getState().sessions["picker-blank"]?.providerState.provider, "openai", "rejected provider switch preserves selected provider");

    store.createSession("picker-count-lock", undefined, true);
    assertEqual(store.switchProviderBeforeStart("picker-count-lock", "openai"), true, "second blank session can switch before prompt count increments");
    store.incrementPromptCount("picker-count-lock");
    const counted = useClaudeStore.getState().sessions["picker-count-lock"];
    assert(counted, "prompt-count lock fixture exists");
    assertEqual(counted.hasBeenStarted, true, "prompt-count increment marks session started");
    assertEqual(counted.providerState.providerLocked, true, "prompt-count increment locks provider");
    assertEqual(store.switchProviderBeforeStart("picker-count-lock", "anthropic"), false, "started session cannot switch provider");

    store.createSession("picker-explicit-locked", "Explicit OpenAI", true, false, "", "openai", true);
    const explicitLocked = useClaudeStore.getState().sessions["picker-explicit-locked"];
    assert(explicitLocked, "explicitly locked session exists");
    assertEqual(explicitLocked.providerState.provider, "openai", "explicit provider survives createSession");
    assertEqual(explicitLocked.providerState.providerLocked, true, "explicit provider lock survives createSession");
    assertEqual(store.switchProviderBeforeStart("picker-explicit-locked", "anthropic"), false, "explicitly locked saved/forked session rejects provider switch");

    store.createSession("picker-legacy-openai");
    const legacy = useClaudeStore.getState().sessions["picker-legacy-openai"];
    assert(legacy, "legacy saved session reopens");
    assertEqual(legacy.providerState.provider, "openai", "legacy saved session reopens with known provider");
    assertEqual(legacy.providerState.providerLocked, true, "legacy saved session reopens provider-locked");
    assertEqual(store.switchProviderBeforeStart("picker-legacy-openai", "anthropic"), false, "legacy saved session rejects provider switch");

    store.createSession("picker-saved-openai");
    const saved = useClaudeStore.getState().sessions["picker-saved-openai"];
    assert(saved, "providerState saved session reopens");
    assertEqual(saved.providerState.provider, "openai", "providerState saved session reopens with known provider");
    assertEqual(saved.providerState.providerLocked, true, "providerState saved session reopens provider-locked");

    store.createSession("picker-disk-hydrated", undefined, true);
    store.loadFromDisk("picker-disk-hydrated", transcriptFixture.slice(0, 2));
    const diskHydrated = useClaudeStore.getState().sessions["picker-disk-hydrated"];
    assert(diskHydrated, "disk-hydrated session exists");
    assertEqual(diskHydrated.promptCount, 1, "disk hydration restores prompt count");
    assertEqual(diskHydrated.hasBeenStarted, true, "disk hydration marks session started when user turns exist");
    assertEqual(diskHydrated.providerState.providerLocked, true, "disk hydration locks sessions with provider history");
    assertEqual(store.switchProviderBeforeStart("picker-disk-hydrated", "openai"), false, "disk-hydrated session rejects provider switch");

    return { name: "empty-chat provider picker lock fixtures", ok: true };
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
    providerPermissionId: "workspace",
    codexCollaborationMode: "plan",
  }));
  assertEqual(createReq.session_id, "session-1", "Codex create keeps local session id");
  assertEqual(createReq.model, "gpt-5.4", "Codex create includes selected model");
  assertEqual(createReq.effort, "xhigh", "Codex create includes selected effort");
  assertEqual(createReq.sandbox_mode, "workspace-write", "Codex workspace preset maps to sandbox");
  assertEqual(createReq.approval_policy, "never", "Codex workspace preset maps to approval policy");
  assertEqual(createReq.collaboration_mode, "plan", "Codex create carries app-server collaboration mode");
  assertNoUndefinedOwnValues(createReq as unknown as Record<string, unknown>, "createReq");

  const buildAfterPlanReq = buildCodexCreateRequest(providerInput({
    codexCollaborationMode: "default",
  }));
  assertEqual(
    buildAfterPlanReq.collaboration_mode,
    "default",
    "Codex build-after-plan requests explicitly exit plan collaboration mode",
  );

  const cursorReviewReq = buildCursorRequest(providerInput({
    provider: "cursor",
    selectedModel: "auto",
    providerPermissionId: "default",
  }));
  assertEqual(cursorReviewReq.session_id, "session-1", "Cursor request keeps local session id");
  assertEqual(cursorReviewReq.permission_mode, "default", "Cursor request carries selected permission mode");
  assert(!Object.prototype.hasOwnProperty.call(cursorReviewReq, "model"), "Cursor auto model omits --model");
  assert(!Object.prototype.hasOwnProperty.call(cursorReviewReq, "force"), "Cursor review mode does not force writes");

  const cursorForceReq = buildCursorRequest(providerInput({
    provider: "cursor",
    threadId: "cursor-thread",
    selectedModel: "gpt-5.3-codex",
    selectedEffort: "ask",
    providerPermissionId: "bypass_all",
  }));
  assertEqual(cursorForceReq.thread_id, "cursor-thread", "Cursor request can carry resume thread id");
  assertEqual(cursorForceReq.model, "gpt-5.3-codex", "Cursor explicit model is included");
  assertEqual(cursorForceReq.mode, "ask", "Cursor effort selector maps to CLI mode");
  assertEqual(cursorForceReq.force, true, "Cursor bypass permission maps to --force");
  assertNoUndefinedOwnValues(cursorForceReq as unknown as Record<string, unknown>, "cursorForceReq");

  const sendReq = buildCodexSendRequest(
    providerInput({ threadId: "thread-1" }),
    createReq,
  );
  assertEqual(sendReq.thread_id, "thread-1", "Codex send includes external app-server thread id");
  assertNoUndefinedOwnValues(sendReq as unknown as Record<string, unknown>, "sendReq");

  const legacyFallbackSendReq = buildCodexSendRequest(
    providerInput({ started: true }),
    createReq,
  );
  assert(
    !Object.prototype.hasOwnProperty.call(legacyFallbackSendReq, "thread_id"),
    "legacy Codex resume fallback does not invent a thread_id",
  );
  assertEqual(
    codexPermissionForOverride("workspace", "plan").sandbox_mode,
    "read-only",
    "plan override downgrades Codex runtime permissions to read-only",
  );

  const yoloReq = buildCodexCreateRequest(providerInput({
    providerPermissionId: "workspace",
    permissionOverride: "bypass_all",
  }));
  assertEqual(yoloReq.yolo, true, "Claude bypass override maps to Codex yolo request");
  assert(!Object.prototype.hasOwnProperty.call(yoloReq, "sandbox_mode"), "yolo request omits sandbox_mode");
  assert(!Object.prototype.hasOwnProperty.call(yoloReq, "approval_policy"), "yolo request omits approval_policy");

  const seededPrompt = promptWithCodexSeed("continue", transcriptFixture.slice(0, 2));
  assert(seededPrompt.includes("Prior transcript"), "Codex fork prompt includes transcript heading");
  assert(seededPrompt.includes("Tool: Read"), "Codex fork prompt includes tool call context");
  const oversizedSeed: ChatMessage[] = transcriptFixture.concat(Array.from({ length: 80 }, (_, index): ChatMessage => {
    const base: ChatMessage = {
      id: `huge-${index}`,
      role: index % 2 === 0 ? "user" : "assistant",
      content: `message ${index} ${"x".repeat(40_000)}`,
      timestamp: index + 10,
    };
    if (index % 2 === 0) return base;
    return {
      ...base,
      toolCalls: [{ id: `tool-${index}`, name: "Bash", input: { command: "x".repeat(40_000) }, result: "y".repeat(40_000) }],
    };
  }));
  const cappedSeededPrompt = promptWithCodexSeed("continue", oversizedSeed);
  assert(
    cappedSeededPrompt.length <= CODEX_MAX_TURN_PROMPT_CHARS,
    "Codex fork prompt is capped below app-server input limit",
  );
  assertEqual(codexDropTurnsForKeepMessages(transcriptFixture, 2), 1, "Codex rewind/fork drops trailing user turns");
  assertEqual(codexDropTurnsForKeepMessages(transcriptFixture, 10), 0, "Codex drop-turn calculation never goes negative");

  return { name: "provider runtime create/send/fork/rewind fixtures", ok: true };
}

export function verifyProviderLifecycleAndHistorySurfaceFixtures(): VerificationResult {
  const providerRuntimeHelpers = {
    runProviderTurn,
    prepareProviderTurnInput,
    cancelProviderSession,
    closeProviderSession,
    truncateProviderHistory,
    prepareProviderFork,
    hydrateProviderHistory,
    deleteProviderHistory,
  } satisfies {
    runProviderTurn: typeof runProviderTurn;
    prepareProviderTurnInput: typeof prepareProviderTurnInput;
    cancelProviderSession: typeof cancelProviderSession;
    closeProviderSession: typeof closeProviderSession;
    truncateProviderHistory: typeof truncateProviderHistory;
    prepareProviderFork: typeof prepareProviderFork;
    hydrateProviderHistory: typeof hydrateProviderHistory;
    deleteProviderHistory: typeof deleteProviderHistory;
  };
  void providerRuntimeHelpers;

  for (const provider of PROVIDER_IDS) {
    assert(isProviderId(provider), `${provider} is a supported provider id`);
    const runtime = getProviderRuntime(provider);
    assertEqual(runtime.provider, provider, `${provider} runtime keeps its provider id`);
    assertEqual(
      providerHistorySource(provider),
      getProviderManifest(provider).history.source,
      `${provider} runtime history source matches manifest`,
    );

    for (const operation of providerLifecycleOperations) {
      assertEqual(typeof runtime[operation], "function", `${provider} runtime exposes ${operation}`);
    }

    for (const capability of providerHistoryCapabilities) {
      assertEqual(
        providerHistorySupports(provider, capability),
        runtime.history.capabilities[capability],
        `${provider} history ${capability} helper matches runtime capability`,
      );
      const handler = runtime.history[providerHistoryHandlerNames[capability]];
      if (runtime.history.capabilities[capability]) {
        assertEqual(typeof handler, "function", `${provider} history ${capability} has a handler when enabled`);
      }
    }
  }

  assertEqual(typeof getProviderRuntime("anthropic").prepareTurn, "function", "Anthropic runtime owns temp MCP setup hook");
  assertEqual(typeof getProviderRuntime("openai").prepareTurn, "function", "OpenAI runtime owns frontend turn setup hook");

  const futureUnsupported = createUnsupportedFutureRuntime("opencode");
  assertEqual(futureUnsupported.provider, "opencode", "unsupported future runtime keeps provider id");
  assertEqual(futureUnsupported.history.source, "none", "unsupported future runtime starts with no history source");
  for (const capability of providerHistoryCapabilities) {
    assertEqual(
      futureUnsupported.history.capabilities[capability],
      false,
      `unsupported future runtime history ${capability} fails closed`,
    );
  }
  assert(
    unsupportedFutureProvider("opencode", "send").message.includes("no send runtime binding"),
    "unsupported future runtime lifecycle operations fail closed",
  );

  return { name: "provider lifecycle/history conformance fixtures", ok: true };
}

export function verifyProviderPermissionHelperFixtures(): VerificationResult {
  for (const provider of PROVIDER_IDS) {
    const manifest = getProviderManifest(provider);
    const defaultPermission = getDefaultProviderPermissionId(provider);
    assertEqual(defaultPermission, manifest.defaultPermission, `${provider} default permission is manifest-owned`);
    assert(isProviderPermissionId(provider, defaultPermission), `${provider} default permission is listed`);
    assertEqual(
      getProviderPermissionOption(provider, "missing").id,
      defaultPermission,
      `${provider} missing permission falls back to default`,
    );
  }

  assertEqual(getNextProviderPermissionId("openai", "workspace"), "full-auto", "OpenAI permission cycling follows manifest order");
  assertEqual(
    getNextProviderPermissionId("openai", "missing"),
    "read-only",
    "OpenAI unknown current permission cycles to the first manifest option",
  );
  assertEqual(
    getProviderPermissionInputPresentation("anthropic", "default").label,
    "ask permissions on",
    "Anthropic input permission label uses manifest input label and suffix",
  );
  assertEqual(
    getProviderPermissionInputPresentation("openai", "workspace").label,
    "workspace sandbox",
    "OpenAI input permission label uses manifest suffix",
  );
  assertEqual(
    permissionModeFromProviderPermission("workspace", "plan"),
    "plan",
    "Codex permission ids do not masquerade as Claude permission modes",
  );
  assertEqual(
    permissionModeFromProviderPermission("accept_edits"),
    "accept_edits",
    "Claude permission ids round-trip to permission modes",
  );

  return { name: "provider permission helper conformance fixtures", ok: true };
}

export function verifyProviderMetadataHelperFixtures(): VerificationResult {
  const openaiState = resolveSessionProviderState({
    provider: "openai",
    providerMetadata: {
      openai: {
        codexThreadId: "thread-provider-metadata",
        selectedCodexPermission: "workspace",
      },
    },
    selectedModel: "gpt-5.5",
    selectedEffort: "medium",
  });
  assertEqual(openaiState.provider, "openai", "metadata helper fixture resolves OpenAI provider");
  assertEqual(
    getProviderSessionMetadata(openaiState, "openai")?.codexThreadId,
    "thread-provider-metadata",
    "generic metadata helper reads provider-owned OpenAI thread id",
  );
  assertEqual(
    getProviderPermissionId(resolveSessionProviderState({
      provider: "openai",
      codexThreadId: "thread-flat-compat",
      selectedCodexPermission: "full-auto",
    }), "openai"),
    "full-auto",
    "OpenAI permission helper keeps flat compatibility fallback",
  );
  assertEqual(
    resolveProviderSessionMetadata({ provider: "anthropic" }, "anthropic"),
    undefined,
    "Anthropic metadata helper stays empty until provider-owned metadata exists",
  );
  assertEqual(
    getOpenAiProviderSessionMetadata(resolveSessionProviderState({ provider: "anthropic" })),
    undefined,
    "OpenAI metadata helper does not invent metadata for Anthropic sessions",
  );

  return { name: "provider metadata helper conformance fixtures", ok: true };
}

export function verifyDelegationChildSpawnFixtures(): VerificationResult {
  const mcpEnv = buildDelegationMcpEnv({
    delegationPort: 49152,
    delegationSecret: "secret",
    groupId: "group-1",
    agentLabel: "Agent 1",
  });
  assert(mcpEnv, "delegation MCP env is built when port and secret are available");
  assertEqual(getDelegationMcpTransport("anthropic"), "temp-config", "Anthropic delegation uses a temp MCP config");
  assertEqual(getDelegationMcpTransport("openai"), "env", "OpenAI delegation uses runtime MCP env");
  assertEqual(getDelegationMcpTransport("cursor"), "env", "Cursor delegation uses runtime MCP env");

  const inheritedRuntime = resolveDelegationChildRuntimeSettings({
    parentSession: {
      providerState: {
        provider: "openai",
        providerLocked: true,
        selectedModel: "gpt-5.4",
        selectedEffort: "medium",
        providerPermissions: {
          openai: "full-auto",
        },
        seedTranscript: null,
        providerMetadata: {
          openai: {
            codexThreadId: "thread-parent",
            selectedCodexPermission: "full-auto",
          },
        },
      },
      skipOpenwolf: true,
    },
    selectedProvider: "anthropic",
    selectedModel: "sonnet",
    selectedEffort: "high",
    selectedProviderPermissionId: "workspace",
  });
  assertEqual(inheritedRuntime.provider, "openai", "delegation child inherits parent provider");
  assertEqual(inheritedRuntime.selectedModel, "gpt-5.4", "delegation child inherits parent model");
  assertEqual(inheritedRuntime.selectedEffort, "medium", "delegation child inherits parent effort");
  assertEqual(inheritedRuntime.selectedProviderPermissionId, "full-auto", "delegation child inherits parent provider permission");
  assertEqual(inheritedRuntime.inheritSkipOpenwolf, true, "delegation child inherits parent OpenWolf skip preference");

  const openaiChild = buildDelegationChildProviderTurnInput({
    provider: "openai",
    sessionId: "child-openai",
    cwd: "/repo",
    prompt: "do the task",
    selectedModel: "gpt-5.5",
    selectedEffort: "high",
    selectedProviderPermissionId: "workspace",
    inheritSkipOpenwolf: false,
    mcpEnv,
  });

  assertEqual(openaiChild.provider, "openai", "delegation OpenAI child keeps provider");
  assertEqual(openaiChild.started, false, "delegation child starts as a first turn");
  assertEqual(openaiChild.permissionOverride, "bypass_all", "delegation child uses bypass override");
  assertEqual(openaiChild.skipOpenwolf, true, "delegation OpenAI child skips OpenWolf bootstrap");
  assertEqual(openaiChild.skipGitRepoCheck, true, "delegation OpenAI child skips git repo check");
  assertEqual(openaiChild.mcpEnv?.T64_AGENT_LABEL, "Agent 1", "delegation OpenAI child receives MCP env");
  assert(!Object.prototype.hasOwnProperty.call(openaiChild, "mcpConfig"), "delegation OpenAI child does not receive Claude MCP config");
  assert(!Object.prototype.hasOwnProperty.call(openaiChild, "noSessionPersistence"), "delegation OpenAI child omits Claude persistence flag");
  assertNoUndefinedOwnValues(openaiChild as unknown as Record<string, unknown>, "openaiChild");

  const cursorChild = buildDelegationChildProviderTurnInput({
    provider: "cursor",
    sessionId: "child-cursor",
    cwd: "/repo",
    prompt: "do the task",
    selectedModel: "auto",
    selectedEffort: "default",
    selectedProviderPermissionId: "bypass_all",
    inheritSkipOpenwolf: false,
    mcpEnv,
  });

  assertEqual(cursorChild.provider, "cursor", "delegation Cursor child keeps provider");
  assertEqual(cursorChild.skipOpenwolf, true, "delegation Cursor child skips OpenWolf bootstrap");
  assertEqual(cursorChild.skipGitRepoCheck, true, "delegation Cursor child skips git repo check");
  assertEqual(cursorChild.mcpEnv?.T64_AGENT_LABEL, "Agent 1", "delegation Cursor child receives MCP env");
  assert(!Object.prototype.hasOwnProperty.call(cursorChild, "mcpConfig"), "delegation Cursor child does not receive Claude MCP config");
  assertNoUndefinedOwnValues(cursorChild as unknown as Record<string, unknown>, "cursorChild");

  const anthropicChild = buildDelegationChildProviderTurnInput({
    provider: "anthropic",
    sessionId: "child-anthropic",
    cwd: "/repo",
    prompt: "do the task",
    selectedModel: "sonnet",
    selectedEffort: "high",
    selectedProviderPermissionId: "workspace",
    inheritSkipOpenwolf: true,
    mcpEnv,
  });

  assertEqual(anthropicChild.provider, "anthropic", "delegation Anthropic child keeps provider");
  assertEqual(anthropicChild.skipOpenwolf, true, "delegation Anthropic child inherits OpenWolf preference");
  assertEqual(anthropicChild.mcpEnv?.T64_AGENT_LABEL, "Agent 1", "delegation Anthropic child carries MCP env for runtime temp config");
  assertEqual(anthropicChild.noSessionPersistence, true, "delegation Anthropic child disables session persistence");
  assert(!Object.prototype.hasOwnProperty.call(anthropicChild, "mcpConfig"), "delegation Anthropic child defers temp MCP config creation to runtime prep");
  assert(!Object.prototype.hasOwnProperty.call(anthropicChild, "skipGitRepoCheck"), "delegation Anthropic child omits Codex git flag");
  assertNoUndefinedOwnValues(anthropicChild as unknown as Record<string, unknown>, "anthropicChild");

  return { name: "delegation child provider turn fixtures", ok: true };
}

export function verifyDelegationWorkflowFixtures(): VerificationResult {
  assertEqual(parseDelegateCommand("/delegate split this safely"), "split this safely", "/delegate command parser extracts the user goal");
  assertEqual(parseDelegateCommand("/delegate   "), null, "empty /delegate command does not build a planner turn");

  const openAiPlan = buildDelegationPlanRequest({
    provider: "openai",
    userGoal: "split frontend and backend work",
  });
  assertEqual(openAiPlan.displayText, "/delegate split frontend and backend work", "delegation plan keeps user-facing command text");
  assert(openAiPlan.providerPrompt.includes("StartDelegation"), "delegation planner prompt asks for the MCP StartDelegation tool");
  assert(openAiPlan.providerPrompt.includes("<T64_START_DELEGATION>"), "delegation planner prompt includes provider-neutral fallback tag");
  assert(!Object.prototype.hasOwnProperty.call(openAiPlan, "permissionOverride"), "OpenAI delegation planner does not invent an override");

  const cursorPlan = buildDelegationPlanRequest({
    provider: "cursor",
    userGoal: "split the work",
  });
  assertEqual(cursorPlan.permissionOverride, "bypass_all", "Cursor delegation planner permission comes from manifest policy");

  const explicitPlan = buildDelegationPlanRequest({
    provider: "cursor",
    userGoal: "plan only",
    permissionOverride: "plan",
  });
  assertEqual(explicitPlan.permissionOverride, "plan", "explicit delegation permission override wins over manifest default");

  const parsedTool = parseDelegationStartFromMessage({
    content: "",
    toolCalls: [{
      id: "tool-1",
      name: "terminal-64-StartDelegation",
      input: {
        context: "shared context",
        tasks: [{ description: "task one" }, { description: "task two" }],
      },
    }],
  });
  assert(parsedTool, "StartDelegation tool call parses into a delegation plan");
  assertEqual(parsedTool.tasks.length, 2, "StartDelegation parser keeps task objects");

  const parsedFallback = parseDelegationStartFromMessage({
    content: `<T64_START_DELEGATION>{"context":"fallback context","tasks":["task one","task two"]}</T64_START_DELEGATION>`,
  });
  assertEqual(parsedFallback?.context, "fallback context", "fallback JSON tag parses shared context");
  assertEqual(parsedFallback?.tasks[0]?.description, "task one", "fallback JSON parser accepts string tasks");

  const parsedLegacy = parseDelegationStartFromMessage({
    content: "[DELEGATION_START]\n[CONTEXT] legacy context\n[TASK] task one\n[TASK] task two\n[DELEGATION_END]",
  });
  assertEqual(parsedLegacy?.context, "legacy context", "legacy delegation block remains supported");

  const childSpawn = buildDelegationChildSpawnPlan({
    sharedContext: "shared",
    taskDescription: "write tests",
    taskIndex: 1,
    taskCount: 3,
    teamChatEnabled: true,
  });
  assertEqual(childSpawn.agentLabel, "Agent 2", "child spawn helper builds deterministic agent label");
  assert(childSpawn.initialPrompt.includes("read_team"), "child spawn prompt includes team chat instructions when available");

  assertNoUndefinedOwnValues(openAiPlan as unknown as Record<string, unknown>, "openAiPlan");
  assertNoUndefinedOwnValues(cursorPlan as unknown as Record<string, unknown>, "cursorPlan");

  return { name: "delegation workflow fixtures", ok: true };
}

export function verifyProviderIpcRequestTypingFixtures(): VerificationResult {
  const openaiCreate = {
    provider: "openai",
    req: buildCodexCreateRequest(providerInput()),
  } satisfies ProviderCreateRequest<"openai">;
  const openaiSend = {
    provider: "openai",
    req: buildCodexSendRequest(providerInput({ threadId: "thread-1" }), openaiCreate.req),
  } satisfies ProviderSendRequest<"openai">;
  const anthropicCreate = {
    provider: "anthropic",
    req: {
      session_id: "claude-1",
      cwd: "/repo",
      prompt: "hello",
      permission_mode: "default",
    },
  } satisfies ProviderCreateRequest<"anthropic">;
  const cursorCreate = {
    provider: "cursor",
    req: buildCursorRequest(providerInput({ provider: "cursor" })),
  } satisfies ProviderCreateRequest<"cursor">;

  // @ts-expect-error provider ids are intentionally closed until a runtime is implemented.
  const unsupportedProvider = { provider: "opencode", req: openaiCreate.req } satisfies ProviderCreateRequest;
  // @ts-expect-error OpenAI create requests must include a prompt at the generic IPC boundary.
  const missingPrompt = { provider: "openai", req: { session_id: "codex-1", cwd: "/repo" } } satisfies ProviderCreateRequest<"openai">;
  // @ts-expect-error exactOptionalPropertyTypes requires callers to omit optional values instead of passing undefined.
  const undefinedOptional = { session_id: "codex-1", cwd: "/repo", prompt: "hello", model: undefined } satisfies CreateCodexRequest;
  void unsupportedProvider;
  void missingPrompt;
  void undefinedOptional;

  assertEqual(openaiCreate.provider, "openai", "generic provider_create carries OpenAI discriminator");
  assertEqual(openaiSend.req.thread_id, "thread-1", "generic provider_send carries OpenAI thread id");
  assertEqual(anthropicCreate.req.permission_mode, "default", "generic provider_create carries Anthropic request shape");
  assertEqual(cursorCreate.req.permission_mode, "default", "generic provider_create carries Cursor request shape");

  return { name: "generic provider IPC request typing fixtures", ok: true };
}

export function verifyFutureProviderStubFixtures(): VerificationResult {
  assert(!isProviderId("opencode"), "future provider ids fail closed until added to the manifest registry");

  const currentProviderRegistry = {
    anthropic: getProviderManifest("anthropic"),
    openai: getProviderManifest("openai"),
    cursor: getProviderManifest("cursor"),
  };
  // @ts-expect-error adding a ProviderId must also add a manifest entry.
  const missingFutureManifestRegistry: Record<FutureProviderId, FutureProviderManifest> = currentProviderRegistry;
  void missingFutureManifestRegistry;

  const futureProviderRegistry = {
    ...currentProviderRegistry,
    opencode: futureProviderStubManifest,
  } satisfies Record<FutureProviderId, FutureProviderManifest>;

  assertEqual(futureProviderRegistry.opencode.id, "opencode", "future stub manifest keeps provider id");
  assert(
    futureProviderRegistry.opencode.models.some((model) => model.id === futureProviderRegistry.opencode.defaultModel),
    "future stub manifest default model is listed",
  );
  assert(
    !futureProviderRegistry.opencode.capabilities.fork,
    "future stub manifest starts with unsupported capabilities fail-closed",
  );
  assertEqual(
    futureProviderRegistry.opencode.history.source,
    "none",
    "future stub manifest starts with explicit no-history source",
  );
  assertEqual(
    futureProviderRegistry.opencode.delegation.mcpTransport,
    "env",
    "future stub manifest declares delegation MCP transport",
  );

  const currentRuntimeRegistry = {
    anthropic: getProviderRuntime("anthropic"),
    openai: getProviderRuntime("openai"),
    cursor: getProviderRuntime("cursor"),
  };
  // @ts-expect-error adding a ProviderId must also add a runtime entry.
  const missingFutureRuntimeRegistry: Record<FutureProviderId, FutureProviderRuntime> = currentRuntimeRegistry;
  void missingFutureRuntimeRegistry;

  const futureRuntimeRegistry = {
    ...currentRuntimeRegistry,
    opencode: createUnsupportedFutureRuntime("opencode"),
  } satisfies Record<FutureProviderId, FutureProviderRuntime>;
  assertEqual(futureRuntimeRegistry.opencode.provider, "opencode", "future stub runtime keeps provider id");
  assert(
    unsupportedFutureProvider("opencode", "create").message.includes("no create runtime binding"),
    "future stub runtime fails closed before implementation",
  );

  const currentProviderStateCannotUseOpenCode = {
    // @ts-expect-error current providerState is closed until the ProviderId and providerState shapes are extended.
    provider: "opencode",
    providerLocked: false,
    selectedModel: null,
    selectedEffort: null,
    seedTranscript: null,
    providerMetadata: {},
    providerPermissions: {},
  } satisfies ProviderSessionState;
  void currentProviderStateCannotUseOpenCode;

  const futureProviderState = {
    provider: "opencode",
    providerLocked: false,
    selectedModel: "stub-model",
    selectedEffort: "stub-effort",
    seedTranscript: null,
    providerMetadata: {
      opencode: {
        threadId: null,
        permissionProfile: "stub",
      },
    },
    providerPermissions: {
      opencode: "stub",
    },
  } satisfies FutureProviderSessionState;
  assertEqual(
    futureProviderState.providerMetadata.opencode?.permissionProfile,
    "stub",
    "future providerState keeps provider-owned metadata",
  );

  const currentProviderCreateCannotUseOpenCode = {
    // @ts-expect-error current generic IPC is closed until a provider-owned request binding is added.
    provider: "opencode",
    req: buildCodexCreateRequest(providerInput()),
  } satisfies ProviderCreateRequest;
  void currentProviderCreateCannotUseOpenCode;

  const futureCreateRequest = {
    provider: "opencode",
    req: {
      session_id: "opencode-1",
      cwd: "/repo",
      prompt: "hello",
      client_profile: "stub",
    },
  } satisfies FutureProviderCreateRequest;
  assertEqual(futureCreateRequest.req.client_profile, "stub", "future provider IPC keeps provider-owned request shape");

  return { name: "future provider stub extension fixtures", ok: true };
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

  const cursorDecoder = new CursorLiveEventDecoder();
  const cursorToolEvents = cursorDecoder.decode("cursor-session", JSON.stringify({
    type: "tool_call",
    subtype: "started",
    call_id: "cursor-tool",
    tool_call: {
      mcpToolCall: {
        args: {
          name: "terminal-64-StartDelegation",
          args: {
            context: "shared context",
            tasks: [{ description: "task one" }, { description: "task two" }],
          },
          toolName: "StartDelegation",
        },
      },
    },
  }));
  const cursorToolEvent = cursorToolEvents.find((event) => event.kind === "tool_call");
  assert(cursorToolEvent?.kind === "tool_call", "Cursor MCP tool_call normalizes into a provider tool call");
  assertEqual(cursorToolEvent.toolCall.name, "terminal-64-StartDelegation", "Cursor MCP tool name keeps provider-prefixed name");
  assertEqual(cursorToolEvent.toolCall.input.context, "shared context", "Cursor MCP nested args unwrap into provider input");
  assert(Array.isArray(cursorToolEvent.toolCall.input.tasks), "Cursor MCP nested task array is visible to delegation parser");

  const cursorMcpStatus = cursorDecoder.decode("cursor-session", JSON.stringify({
    type: "mcp_status",
    servers: [{
      name: "terminal-64",
      status: "ready",
      transport: "stdio",
      tools: [{ name: "StartDelegation" }],
    }],
  }));
  const cursorMcpEvent = cursorMcpStatus.find((event) => event.kind === "mcp_status");
  assert(cursorMcpEvent?.kind === "mcp_status", "Cursor synthetic MCP status normalizes into provider event");
  assertEqual(cursorMcpEvent.servers.length, 1, "Cursor MCP status keeps server list");

  return { name: "provider event/tool normalization fixtures", ok: true };
}

export function runProviderModularityVerification(): VerificationResult[] {
  return [
    verifyProviderManifestDefaults(),
    verifyProviderRuntimeFixtures(),
    verifyProviderLifecycleAndHistorySurfaceFixtures(),
    verifyProviderPermissionHelperFixtures(),
    verifyProviderMetadataHelperFixtures(),
    verifyDelegationChildSpawnFixtures(),
    verifyDelegationWorkflowFixtures(),
    verifyProviderIpcRequestTypingFixtures(),
    verifyFutureProviderStubFixtures(),
    verifyCodexPermissionFixtures(),
    verifyProviderEventNormalizationFixtures(),
    verifyProviderStateMigrationFixture(),
    verifyProviderPickerLockFixtures(),
  ];
}
