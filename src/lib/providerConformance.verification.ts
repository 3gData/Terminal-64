import {
  isProviderRuntimeEvent,
  providerRuntimeEventToNormalized,
  type ProviderRuntimeEvent,
} from "../contracts/providerEvents";
import type { ProviderSnapshot } from "../contracts/providerSnapshot";
import {
  deleteProviderHistory,
  hydrateProviderHistory,
  prepareProviderFork,
  truncateProviderHistory,
} from "./providerRuntime";
import { CursorLiveEventDecoder } from "./cursorEventDecoder";
import {
  buildDelegationChildProviderTurnInput,
  buildDelegationMcpEnv,
  getDelegationMcpTransport,
  resolveDelegationChildRuntimeSettings,
} from "./delegationChildRuntime";
import {
  defineProviderManifest,
  getProviderDefaultControlValues,
  getProviderDefaultPermission,
  getProviderManifest,
  PROVIDER_IDS,
  providerControlOptionValue,
  type ProviderManifestDefinition,
} from "./providers";
import {
  listManifestProviderSnapshots,
  mergeProviderSnapshotsWithManifestFallback,
  providerSnapshotOptionValue,
  snapshotFromProviderManifest,
} from "./providerSnapshots";
import {
  getOpenAiProviderSessionMetadata,
  getProviderRuntimeResumeId,
  getProviderSessionRuntimeMetadata,
  resolveProviderRuntimeResumeId,
  resolveSessionProviderState,
} from "../stores/providerSessionStore";
import type { ChatMessage } from "./types";

type VerificationResult = {
  name: string;
  ok: true;
};

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(`[provider conformance] ${message}`);
  }
}

function assertEqual<T>(actual: T, expected: T, message: string): void {
  assert(Object.is(actual, expected), `${message}: expected ${String(expected)}, got ${String(actual)}`);
}

const transcriptFixture: ChatMessage[] = [
  { id: "user-1", role: "user", content: "inspect this", timestamp: 1 },
  { id: "assistant-1", role: "assistant", content: "done", timestamp: 2 },
];

function unsupportedCursorHistoryInput() {
  return {
    provider: "cursor" as const,
    sessionId: "cursor-history-fixture",
    cwd: "/repo",
    keepMessages: 1,
    preMessages: transcriptFixture,
  };
}

export function verifyProviderSnapshotConformanceFixtures(): VerificationResult {
  const manifestSnapshots = listManifestProviderSnapshots();
  assertEqual(manifestSnapshots.length, 3, "manifest snapshots cover every registered frontend provider");
  assertEqual(manifestSnapshots.length, PROVIDER_IDS.length, "manifest snapshots stay aligned with registered provider ids");

  const backendOwnedCapabilitySnapshots = PROVIDER_IDS.map((provider) => {
    const fallback = snapshotFromProviderManifest(getProviderManifest(provider));
    return {
      ...fallback,
      display: {
        ...fallback.display,
        label: `${fallback.display.label} Backend`,
      },
      models: [],
      options: [],
      capabilities: {
        mcp: false,
        plan: false,
        fork: false,
        rewind: false,
        images: false,
        hookLog: false,
        nativeSlashCommands: false,
        compact: false,
        sessionModelSwitch: "unsupported",
        history: {
          hydrate: false,
          fork: false,
          rewind: false,
          delete: false,
        },
      },
    } satisfies ProviderSnapshot;
  });
  const backendOwnedMerged = mergeProviderSnapshotsWithManifestFallback(backendOwnedCapabilitySnapshots);
  assertEqual(backendOwnedMerged.length, PROVIDER_IDS.length, "backend snapshots expose every registered provider");
  for (const provider of PROVIDER_IDS) {
    const mergedSnapshot = backendOwnedMerged.find((snapshot) => snapshot.id === provider);
    assert(mergedSnapshot, `${provider} backend snapshot is present after fallback merge`);
    assert(
      mergedSnapshot.display.label.endsWith("Backend"),
      `${provider} backend-owned display descriptor wins over manifest fallback`,
    );
    assertEqual(mergedSnapshot.capabilities.mcp, false, `${provider} backend-owned mcp capability wins`);
    assertEqual(mergedSnapshot.capabilities.plan, false, `${provider} backend-owned plan capability wins`);
    assertEqual(mergedSnapshot.capabilities.sessionModelSwitch, "unsupported", `${provider} backend-owned model switching wins`);
    assertEqual(mergedSnapshot.capabilities.history.hydrate, false, `${provider} backend-owned history capability wins`);
    assertEqual(mergedSnapshot.options.length > 0, true, `${provider} manifest fallback only fills missing controls`);
    assertEqual(mergedSnapshot.models.length > 0, true, `${provider} manifest fallback only fills missing models`);
  }

  const openaiManifestSnapshot = snapshotFromProviderManifest(getProviderManifest("openai"));
  assertEqual(openaiManifestSnapshot.id, "openai", "manifest snapshot keeps provider id");
  assertEqual(openaiManifestSnapshot.options.some((control) => control.scope === "composer"), true, "manifest snapshot exposes composer controls");
  assertEqual(openaiManifestSnapshot.options.some((control) => control.id === "sandbox"), true, "OpenAI snapshot exposes provider-owned sandbox control");
  assertEqual(openaiManifestSnapshot.models.some((model) => model.default === true), true, "snapshot model values mark the default");

  const backendCursorSnapshot = {
    id: "cursor",
    display: {
      label: "Cursor Backend",
      shortLabel: "Cursor",
      brandTitle: "Cursor Agent",
      emptyStateLabel: "Cursor Agent",
      defaultSessionName: "Cursor",
    },
    auth: { status: "unknown", label: "Cursor Agent CLI" },
    install: { status: "missing", command: "cursor-agent" },
    status: { state: "degraded", message: "fixture status" },
    models: [],
    options: [],
    capabilities: {
      mcp: true,
      plan: true,
      fork: false,
      rewind: false,
      images: false,
      hookLog: false,
      nativeSlashCommands: false,
      compact: false,
      sessionModelSwitch: "unsupported",
      history: {
        hydrate: false,
        fork: false,
        rewind: false,
        delete: false,
      },
    },
    slashCommands: [],
  } satisfies ProviderSnapshot;

  const merged = mergeProviderSnapshotsWithManifestFallback([backendCursorSnapshot]);
  const cursorSnapshot = merged.find((snapshot) => snapshot.id === "cursor");
  assert(cursorSnapshot, "snapshot fallback merger keeps Cursor");
  assertEqual(cursorSnapshot.display.label, "Cursor Backend", "backend snapshot display wins over manifest fallback");
  assertEqual(cursorSnapshot.status.state, "degraded", "backend snapshot status wins over manifest fallback");
  assertEqual(cursorSnapshot.options.length > 0, true, "manifest fallback fills missing backend controls");
  assertEqual(cursorSnapshot.models.length > 0, true, "manifest fallback fills missing backend models");
  const modeControl = cursorSnapshot.options.find((control) => control.id === "mode");
  assert(modeControl, "Cursor fallback keeps provider-owned mode control");
  assertEqual(modeControl.scope, "topbar", "snapshot controls use generic scope");
  assertEqual(modeControl.kind, "select", "snapshot controls use generic kind");
  assertEqual(modeControl.options.some((option) => option.id === "ask"), true, "snapshot controls use generic options array");
  assert(!Object.prototype.hasOwnProperty.call(modeControl, "placement"), "snapshot controls do not use legacy placement");
  assert(!Object.prototype.hasOwnProperty.call(modeControl, "values"), "snapshot controls do not use legacy values");

  const futureNonSelectManifest = defineProviderManifest({
    id: "future-tools",
    ui: {
      label: "Future Tools",
      shortLabel: "Future",
      brandTitle: "Future Tools",
      emptyStateLabel: "Future Tools",
      defaultSessionName: "Future",
      modelMenuLabel: "Profile",
      effortMenuLabel: "Stream",
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
      noSessionPersistence: true,
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
      hydrateFailureLabel: "Future Tools",
    },
    controls: [
      {
        id: "stream",
        label: "Stream",
        kind: "boolean",
        scope: "topbar",
        defaultValue: true,
        options: [{ id: "enabled", label: "Enabled", value: true }],
      },
      {
        id: "temperature",
        label: "Temperature",
        kind: "number",
        scope: "topbar",
        defaultValue: 0.2,
        options: [{ id: "balanced", label: "Balanced", value: 0.2 }],
      },
      {
        id: "profile",
        label: "Profile",
        kind: "text",
        scope: "composer",
        defaultValue: "default-profile",
        options: [],
      },
    ],
  } satisfies ProviderManifestDefinition<"future-tools">);
  assertEqual(futureNonSelectManifest.id, "future-tools", "future provider manifest keeps generic provider id");
  assertEqual(futureNonSelectManifest.models.length, 0, "future non-select provider does not need model compatibility values");
  assertEqual(futureNonSelectManifest.efforts.length, 0, "future non-select provider does not need effort compatibility values");
  assertEqual(futureNonSelectManifest.defaultModel, "", "future non-select provider does not invent a legacy model");
  assertEqual(futureNonSelectManifest.defaultEffort, "", "future non-select provider does not invent a legacy effort");
  assertEqual(futureNonSelectManifest.defaultPermission, "default-profile", "future text composer control can own the default permission value");
  const futureStreamControl = futureNonSelectManifest.controls.find((control) => control.id === "stream");
  const futureTemperatureControl = futureNonSelectManifest.controls.find((control) => control.id === "temperature");
  assert(futureStreamControl, "future boolean manifest control exists");
  assert(futureTemperatureControl, "future number manifest control exists");
  assertEqual(futureStreamControl.defaultValue, true, "future boolean manifest control keeps typed default");
  assertEqual(futureTemperatureControl.defaultValue, 0.2, "future number manifest control keeps typed default");
  const futureStreamOption = futureStreamControl.options[0];
  const futureTemperatureOption = futureTemperatureControl.options[0];
  assert(futureStreamOption, "future boolean manifest option exists");
  assert(futureTemperatureOption, "future number manifest option exists");
  assertEqual(providerControlOptionValue(futureStreamOption), true, "future boolean manifest option keeps typed value");
  assertEqual(providerControlOptionValue(futureTemperatureOption), 0.2, "future number manifest option keeps typed value");

  const futureProviderControls = [
    {
      id: "stream",
      label: "Stream",
      kind: "boolean",
      scope: "topbar",
      defaultValue: true,
      options: [{ id: "enabled", label: "Enabled", value: true }],
    },
    {
      id: "temperature",
      label: "Temperature",
      kind: "number",
      scope: "topbar",
      defaultValue: 0.2,
      options: [{ id: "balanced", label: "Balanced", value: 0.2 }],
    },
    {
      id: "profile",
      label: "Profile",
      kind: "text",
      scope: "composer",
      defaultValue: "default",
      options: [],
    },
  ] satisfies ProviderSnapshot["options"];
  const streamControl = futureProviderControls[0];
  const temperatureControl = futureProviderControls[1];
  assert(streamControl, "future boolean fixture exists");
  assert(temperatureControl, "future number fixture exists");
  const streamOption = streamControl.options[0];
  const temperatureOption = temperatureControl.options[0];
  assert(streamOption, "future boolean option fixture exists");
  assert(temperatureOption, "future number option fixture exists");
  assertEqual(streamControl.defaultValue, true, "future boolean controls carry typed defaults");
  assertEqual(temperatureControl.defaultValue, 0.2, "future number controls carry typed defaults");
  assertEqual(providerSnapshotOptionValue(streamOption), true, "future boolean options carry typed values");
  assertEqual(providerSnapshotOptionValue(temperatureOption), 0.2, "future number options carry typed values");

  return { name: "provider snapshot conformance fixtures", ok: true };
}

export function verifyCursorRuntimeEventConformanceFixtures(): VerificationResult {
  const runtimeToolEvent = {
    type: "provider.tool",
    provider: "cursor",
    sessionId: "cursor-runtime",
    eventId: "cursor-tool-started",
    createdAt: "2026-04-30T00:00:00Z",
    phase: "started",
    id: "tool-1",
    name: "terminal-64-StartDelegation",
    input: {
      context: "shared",
      tasks: [{ description: "verify" }],
    },
  } satisfies ProviderRuntimeEvent;
  assert(isProviderRuntimeEvent(runtimeToolEvent), "Cursor provider.tool envelope satisfies canonical runtime event guard");
  const runtimeToolUpdates = providerRuntimeEventToNormalized(runtimeToolEvent);
  const runtimeTool = runtimeToolUpdates.find((event) => event.kind === "tool_call");
  assert(runtimeTool?.kind === "tool_call", "canonical provider.tool becomes a generic tool_call update");
  assertEqual(runtimeTool.toolCall.name, "mcp__terminal-64__StartDelegation", "Cursor runtime tool names normalize to MCP names");
  assertEqual(runtimeTool.toolCall.input.context, "shared", "Cursor runtime tool input is preserved");

  const decoder = new CursorLiveEventDecoder();
  const sessionUpdates = decoder.decode("cursor-runtime", JSON.stringify({
    type: "provider.session",
    provider: "cursor",
    sessionId: "cursor-runtime",
    eventId: "cursor-session",
    createdAt: "2026-04-30T00:00:01Z",
    phase: "started",
    threadId: "cursor-native-thread",
    model: "composer-2-fast",
    contextMax: 200000,
  } satisfies ProviderRuntimeEvent));
  assertEqual(sessionUpdates[0]?.kind, "session_started", "Cursor provider.session becomes a generic session update");

  const contentUpdates = decoder.decode("cursor-runtime", JSON.stringify({
    type: "provider.content",
    provider: "cursor",
    sessionId: "cursor-runtime",
    eventId: "cursor-content",
    createdAt: "2026-04-30T00:00:02Z",
    phase: "delta",
    text: "streamed text",
  } satisfies ProviderRuntimeEvent));
  assertEqual(contentUpdates[0]?.kind, "assistant_delta", "Cursor provider.content becomes a generic assistant delta");

  const completedAfterContent = decoder.decode("cursor-runtime", JSON.stringify({
    type: "provider.turn",
    provider: "cursor",
    sessionId: "cursor-runtime",
    eventId: "cursor-turn",
    createdAt: "2026-04-30T00:00:03Z",
    phase: "completed",
    result: "do not duplicate streamed text",
    isError: false,
  } satisfies ProviderRuntimeEvent));
  assertEqual(
    completedAfterContent.some((event) => event.kind === "assistant_message"),
    false,
    "Cursor turn completion does not duplicate assistant text after content deltas",
  );
  assertEqual(
    completedAfterContent.some((event) => event.kind === "turn_completed"),
    true,
    "Cursor turn completion still emits generic turn completion",
  );

  const fallbackDecoder = new CursorLiveEventDecoder();
  const completedWithoutContent = fallbackDecoder.decode("cursor-runtime-fallback", JSON.stringify({
    type: "provider.turn",
    provider: "cursor",
    sessionId: "cursor-runtime-fallback",
    eventId: "cursor-turn-fallback",
    createdAt: "2026-04-30T00:00:04Z",
    phase: "completed",
    result: "final fallback",
    isError: false,
  } satisfies ProviderRuntimeEvent));
  assertEqual(completedWithoutContent[0]?.kind, "assistant_message", "Cursor turn result backfills assistant text without deltas");
  assertEqual(completedWithoutContent[1]?.kind, "turn_completed", "Cursor fallback result also completes the turn");

  return { name: "Cursor runtime event conformance fixtures", ok: true };
}

export function verifyProviderRuntimeMetadataConformanceFixtures(): VerificationResult {
  const openAiState = resolveSessionProviderState({
    provider: "openai",
    runtimeMetadata: {
      openai: {
        historySource: "codex-rollout",
        resume: { id: "thread-runtime" },
        runtimePayload: {
          nativeConversationId: "native-thread",
        },
      },
    },
    providerMetadata: {
      openai: {
        codexThreadId: "thread-legacy",
      },
    },
    providerPermissions: {
      openai: "workspace",
    },
  });
  const openAiRuntime = getProviderSessionRuntimeMetadata(openAiState, "openai");
  assert(openAiRuntime, "OpenAI runtime metadata is present");
  assertEqual(openAiRuntime.historySource, "codex-rollout", "OpenAI runtime metadata owns history source");
  assertEqual(getProviderRuntimeResumeId(openAiState, "openai"), "thread-runtime", "OpenAI runtime metadata owns resume id");
  assertEqual(
    getOpenAiProviderSessionMetadata(openAiState)?.codexThreadId,
    "thread-runtime",
    "OpenAI compatibility metadata reads generic runtime resume id first",
  );
  assert(!Object.prototype.hasOwnProperty.call(openAiRuntime, "codexThreadId"), "runtime metadata has no common codexThreadId field");
  assert(!Object.prototype.hasOwnProperty.call(openAiRuntime, "selectedCodexPermission"), "runtime metadata has no common Codex permission field");

  const cursorState = resolveSessionProviderState({
    provider: "cursor",
    runtimeMetadata: {
      cursor: {
        historySource: "local-transcript",
        resume: { id: "cursor-native-thread" },
        runtimePayload: {
          localTranscript: transcriptFixture,
        },
      },
    },
  });
  const cursorRuntime = getProviderSessionRuntimeMetadata(cursorState, "cursor");
  assert(cursorRuntime, "Cursor runtime metadata is present");
  assertEqual(cursorRuntime.historySource, "local-transcript", "Cursor runtime metadata owns local transcript source");
  assertEqual(
    resolveProviderRuntimeResumeId({ providerState: cursorState }, "cursor"),
    "cursor-native-thread",
    "Cursor runtime metadata owns provider resume id",
  );
  assert(!Object.prototype.hasOwnProperty.call(cursorRuntime, "codexThreadId"), "Cursor runtime metadata has no common Codex thread field");
  assertEqual(getOpenAiProviderSessionMetadata(cursorState), undefined, "Cursor state does not invent OpenAI metadata");

  return { name: "provider runtime metadata conformance fixtures", ok: true };
}

export function verifyDelegationChildRuntimeConformanceFixtures(): VerificationResult {
  const cursorControls = getProviderDefaultControlValues("cursor");
  const settings = resolveDelegationChildRuntimeSettings({
    selectedProvider: "cursor",
    selectedControls: cursorControls,
    selectedProviderPermissionId: getProviderDefaultPermission("cursor"),
  });
  assertEqual(settings.provider, "cursor", "delegation runtime settings use selected provider when no parent exists");
  assertEqual(settings.selectedControls.model, cursorControls.model ?? null, "delegation runtime settings inherit manifest default model control");
  assertEqual(settings.selectedControls["apply-mode"], cursorControls["apply-mode"] ?? null, "delegation runtime settings inherit manifest composer control");
  assertEqual(getDelegationMcpTransport(settings.provider), "env", "delegation runtime transport comes from provider manifest");

  const mcpEnv = buildDelegationMcpEnv({
    delegationPort: 49200,
    delegationSecret: "secret",
    groupId: "group",
    agentLabel: "Verifier",
  });
  assert(mcpEnv, "delegation MCP env is available for conformance fixture");
  const childInput = buildDelegationChildProviderTurnInput({
    ...settings,
    sessionId: "cursor-child",
    cwd: "/repo",
    prompt: "verify child runtime",
    mcpEnv,
  });
  assertEqual(childInput.provider, "cursor", "delegation child turn keeps manifest-selected provider");
  assertEqual(childInput.providerOptions?.cursor?.mcpEnv?.T64_AGENT_LABEL, "Verifier", "delegation child turn carries Cursor MCP env");
  assert(!Object.prototype.hasOwnProperty.call(childInput, "selectedModel"), "delegation child turn does not require legacy selectedModel");
  assert(!Object.prototype.hasOwnProperty.call(childInput, "selectedEffort"), "delegation child turn does not require legacy selectedEffort");
  assert(!Object.prototype.hasOwnProperty.call(childInput.providerOptions ?? {}, "openai"), "Cursor child turn does not receive OpenAI options");
  assert(!Object.prototype.hasOwnProperty.call(childInput.providerOptions ?? {}, "anthropic"), "Cursor child turn does not receive Anthropic options");

  const invalidMcpEnv = buildDelegationMcpEnv({
    delegationPort: 0,
    delegationSecret: "",
    groupId: "group",
    agentLabel: "Verifier",
  });
  assertEqual(invalidMcpEnv, undefined, "delegation MCP env fails closed without a valid port and secret");
  const missingMcpInput = buildDelegationChildProviderTurnInput({
    ...settings,
    sessionId: "cursor-child-missing-mcp",
    cwd: "/repo",
    prompt: "verify missing mcp",
    ...(invalidMcpEnv ? { mcpEnv: invalidMcpEnv } : {}),
  });
  assert(
    !Object.prototype.hasOwnProperty.call(missingMcpInput.providerOptions ?? {}, "cursor"),
    "Cursor delegation child does not invent provider MCP options when connection data is invalid",
  );

  return { name: "delegation child runtime conformance fixtures", ok: true };
}

export async function verifyUnsupportedHistoryConformanceFixtures(): Promise<VerificationResult> {
  const input = unsupportedCursorHistoryInput();
  const rewind = await truncateProviderHistory(input);
  const fork = await prepareProviderFork({
    provider: "cursor",
    parentSessionId: "cursor-parent",
    newSessionId: "cursor-child",
    cwd: "/repo",
    keepMessages: 1,
    preMessages: transcriptFixture,
  });
  const hydrate = await hydrateProviderHistory({
    provider: "cursor",
    sessionId: "cursor-history-fixture",
    cwd: "/repo",
  });
  const deleted = await deleteProviderHistory({
    provider: "cursor",
    sessionId: "cursor-history-fixture",
    cwd: "/repo",
  });

  assertEqual(rewind.status, "unsupported", "Cursor rewind fails as unsupported");
  assertEqual(fork.status, "unsupported", "Cursor fork fails as unsupported");
  assert(hydrate.status === "unsupported", "Cursor hydrate fails as unsupported");
  assertEqual(deleted.status, "unsupported", "Cursor delete fails as unsupported");
  assertEqual(deleted.method, "unsupported", "Cursor delete reports unsupported method");
  assert(rewind.reason?.includes("history rewind"), "Cursor rewind unsupported reason names the closed capability");
  assert(fork.reason?.includes("history fork"), "Cursor fork unsupported reason names the closed capability");
  assert(hydrate.reason?.includes("history hydrate"), "Cursor hydrate unsupported reason names the closed capability");
  assert(deleted.reason?.includes("history delete"), "Cursor delete unsupported reason names the closed capability");

  return { name: "unsupported history operation conformance fixtures", ok: true };
}

export function runProviderConformanceVerification(): VerificationResult[] {
  return [
    verifyProviderSnapshotConformanceFixtures(),
    verifyCursorRuntimeEventConformanceFixtures(),
    verifyProviderRuntimeMetadataConformanceFixtures(),
    verifyDelegationChildRuntimeConformanceFixtures(),
  ];
}

export async function runProviderConformanceAsyncVerification(): Promise<VerificationResult[]> {
  return [
    await verifyUnsupportedHistoryConformanceFixtures(),
  ];
}
