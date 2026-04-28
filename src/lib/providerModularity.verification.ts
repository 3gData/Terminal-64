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
  CODEX_MAX_TURN_PROMPT_CHARS,
  codexPermissionForOverride,
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
import {
  decodeCodexPermission,
  getProviderManifest,
  isProviderId,
  PROVIDER_IDS,
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
  resolveSessionProviderState,
  resolveOpenAiProviderSessionMetadata,
  resolveProviderSessionMetadata,
  STORAGE_KEY,
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
type FutureProviderSessionState = Omit<ProviderSessionState, "provider" | "providerMetadata"> & {
  provider: FutureProviderId;
  providerMetadata: ProviderSessionState["providerMetadata"] & {
    opencode?: {
      threadId: string | null;
      permissionProfile: string | null;
    };
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
    childRuntime: {
      permissionPreset: "selected",
    },
  },
  permissionControl: {
    persistence: "provider-metadata",
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

  assertEqual(anthropic.defaultModel, "sonnet", "Anthropic default model");
  assertEqual(anthropic.defaultEffort, "high", "Anthropic default effort");
  assertEqual(anthropic.defaultPermission, "default", "Anthropic default permission");
  assert(anthropic.models.some((model) => model.id === anthropic.defaultModel), "Anthropic default model is listed");
  assert(anthropic.efforts.some((effort) => effort.id === anthropic.defaultEffort), "Anthropic default effort is listed");
  assert(anthropic.permissions.some((permission) => permission.id === anthropic.defaultPermission), "Anthropic default permission is listed");
  assertEqual(anthropic.delegation.mcpTransport, "temp-config", "Anthropic delegation MCP transport is manifest-owned");
  assertEqual(anthropic.delegation.skipOpenwolf, "inherit", "Anthropic delegation inherits OpenWolf setting");
  assertEqual(
    anthropic.delegation.childRuntime.permissionPreset,
    "bypass_all",
    "Anthropic delegation metadata records bypass permission",
  );
  assertEqual(anthropic.permissionControl.persistence, "settings", "Anthropic permission control uses settings");
  assertEqual(
    anthropic.permissionControl.skipPermissionId,
    "bypass_all",
    "Anthropic skip-permissions preset is manifest-owned",
  );

  assertEqual(openai.defaultModel, "gpt-5.5", "OpenAI default model");
  assertEqual(openai.defaultEffort, "medium", "OpenAI default effort");
  assertEqual(openai.defaultPermission, "workspace", "OpenAI default permission");
  assert(openai.models.some((model) => model.id === openai.defaultModel), "OpenAI default model is listed");
  assert(openai.efforts.some((effort) => effort.id === openai.defaultEffort), "OpenAI default effort is listed");
  assert(openai.permissions.some((permission) => permission.id === openai.defaultPermission), "OpenAI default permission is listed");
  assertEqual(openai.delegation.mcpTransport, "env", "OpenAI delegation MCP transport is manifest-owned");
  assertEqual(openai.delegation.skipOpenwolf, "always", "OpenAI delegation always skips OpenWolf bootstrap");
  assertEqual(
    openai.delegation.childRuntime.permissionPreset,
    "selected",
    "OpenAI delegation metadata records selected permission preset",
  );
  assertEqual(openai.permissionControl.persistence, "provider-metadata", "OpenAI permission control uses provider metadata");
  assert(providerSupports("openai", "fork"), "OpenAI manifest advertises fork support");
  assert(providerSupports("openai", "rewind"), "OpenAI manifest advertises rewind support");
  assert(!providerSupports("openai", "hookLog"), "OpenAI manifest does not expose Claude hook log");

  return { name: "provider manifest defaults", ok: true };
}

export function verifyProviderStateMigrationFixture(): VerificationResult {
  assert(typeof localStorage !== "undefined", "providerState migration fixture requires browser localStorage");

  const sessionId = "provider-verification-legacy-openai";
  const stateSessionId = "provider-verification-state-openai";
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
    }));
    useClaudeStore.setState({ sessions: {} });
    useClaudeStore.getState().createSession(sessionId);
    useClaudeStore.getState().createSession(stateSessionId);
    const migrated = useClaudeStore.getState().sessions[sessionId];
    const stateBacked = useClaudeStore.getState().sessions[stateSessionId];

    assert(migrated, "legacy OpenAI metadata creates a session");
    assertEqual(migrated.providerState.provider, "openai", "legacy provider migrates into providerState");
    assertEqual(migrated.providerState.providerLocked, true, "legacy saved metadata locks migrated provider");
    assertEqual(migrated.providerLocked, true, "legacy provider lock mirror migrates");
    const migratedOpenAi = getOpenAiProviderSessionMetadata(migrated.providerState);
    assertEqual(migratedOpenAi?.codexThreadId, "thread-legacy", "legacy Codex thread id migrates");
    assertEqual(migratedOpenAi?.selectedCodexPermission, "yolo", "legacy Codex permission migrates");
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
    assertEqual(stateBackedOpenAi?.selectedCodexPermission, "workspace", "providerState permission wins over stale flat mirror");
    assertEqual(stateBacked.providerState.selectedModel, "gpt-5.5", "providerState selected model wins over stale flat mirror");

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
    assertEqual(hotReloadFallbackOpenAi?.selectedCodexPermission, "full-auto", "hot-reloaded flat permission falls back into providerState");

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
    const blankOpenAi = getOpenAiProviderSessionMetadata(blank.providerState);
    assertEqual(blank.providerState.provider, "openai", "pre-send provider picker writes providerState provider");
    assertEqual(blank.provider, "openai", "pre-send provider picker writes compatibility provider mirror");
    assertEqual(blank.providerState.providerLocked, false, "pre-send provider switch keeps session unlocked");
    assertEqual(blank.providerState.selectedModel, openaiManifest.defaultModel, "pre-send provider switch resets default model");
    assertEqual(blank.providerState.selectedEffort, openaiManifest.defaultEffort, "pre-send provider switch resets default effort");
    assertEqual(blankOpenAi?.selectedCodexPermission, openaiManifest.defaultPermission, "pre-send provider switch resets provider permission");
    assertEqual(
      providerTurnOperation(providerInput({
        provider: blank.providerState.provider,
        started: blank.hasBeenStarted && blank.promptCount > 0,
        selectedModel: blank.providerState.selectedModel,
        selectedEffort: blank.providerState.selectedEffort,
        selectedCodexPermission: blankOpenAi?.selectedCodexPermission ?? undefined,
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
    selectedCodexPermission: "workspace",
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
    cancelProviderSession,
    closeProviderSession,
    truncateProviderHistory,
    prepareProviderFork,
    hydrateProviderHistory,
    deleteProviderHistory,
  } satisfies {
    runProviderTurn: typeof runProviderTurn;
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

  const futureUnsupported = createUnsupportedFutureRuntime("opencode");
  assertEqual(futureUnsupported.provider, "opencode", "unsupported future runtime keeps provider id");
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
    resolveOpenAiProviderSessionMetadata({
      provider: "openai",
      codexThreadId: "thread-flat-compat",
      selectedCodexPermission: "full-auto",
    })?.selectedCodexPermission,
    "full-auto",
    "OpenAI metadata resolver keeps flat compatibility fallback",
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

  const inheritedRuntime = resolveDelegationChildRuntimeSettings({
    parentSession: {
      providerState: {
        provider: "openai",
        providerLocked: true,
        selectedModel: "gpt-5.4",
        selectedEffort: "medium",
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
    selectedCodexPermission: "workspace",
  });
  assertEqual(inheritedRuntime.provider, "openai", "delegation child inherits parent provider");
  assertEqual(inheritedRuntime.selectedModel, "gpt-5.4", "delegation child inherits parent model");
  assertEqual(inheritedRuntime.selectedEffort, "medium", "delegation child inherits parent effort");
  assertEqual(inheritedRuntime.selectedCodexPermission, "full-auto", "delegation child inherits parent Codex permission");
  assertEqual(inheritedRuntime.inheritSkipOpenwolf, true, "delegation child inherits parent OpenWolf skip preference");

  const openaiChild = buildDelegationChildProviderTurnInput({
    provider: "openai",
    sessionId: "child-openai",
    cwd: "/repo",
    prompt: "do the task",
    selectedModel: "gpt-5.5",
    selectedEffort: "high",
    selectedCodexPermission: "workspace",
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

  const anthropicChild = buildDelegationChildProviderTurnInput({
    provider: "anthropic",
    sessionId: "child-anthropic",
    cwd: "/repo",
    prompt: "do the task",
    selectedModel: "sonnet",
    selectedEffort: "high",
    selectedCodexPermission: "workspace",
    inheritSkipOpenwolf: true,
    mcpConfigPath: "/tmp/t64-mcp.json",
  });

  assertEqual(anthropicChild.provider, "anthropic", "delegation Anthropic child keeps provider");
  assertEqual(anthropicChild.skipOpenwolf, true, "delegation Anthropic child inherits OpenWolf preference");
  assertEqual(anthropicChild.mcpConfig, "/tmp/t64-mcp.json", "delegation Anthropic child receives MCP config path");
  assertEqual(anthropicChild.noSessionPersistence, true, "delegation Anthropic child disables session persistence");
  assert(!Object.prototype.hasOwnProperty.call(anthropicChild, "mcpEnv"), "delegation Anthropic child omits Codex MCP env");
  assert(!Object.prototype.hasOwnProperty.call(anthropicChild, "skipGitRepoCheck"), "delegation Anthropic child omits Codex git flag");
  assertNoUndefinedOwnValues(anthropicChild as unknown as Record<string, unknown>, "anthropicChild");

  return { name: "delegation child provider turn fixtures", ok: true };
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

  return { name: "generic provider IPC request typing fixtures", ok: true };
}

export function verifyFutureProviderStubFixtures(): VerificationResult {
  assert(!isProviderId("opencode"), "future provider ids fail closed until added to the manifest registry");

  const currentProviderRegistry = {
    anthropic: getProviderManifest("anthropic"),
    openai: getProviderManifest("openai"),
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
    futureProviderRegistry.opencode.delegation.mcpTransport,
    "env",
    "future stub manifest declares delegation MCP transport",
  );

  const currentRuntimeRegistry = {
    anthropic: getProviderRuntime("anthropic"),
    openai: getProviderRuntime("openai"),
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
    verifyProviderIpcRequestTypingFixtures(),
    verifyFutureProviderStubFixtures(),
    verifyCodexPermissionFixtures(),
    verifyProviderEventNormalizationFixtures(),
    verifyProviderStateMigrationFixture(),
    verifyProviderPickerLockFixtures(),
  ];
}
