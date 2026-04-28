import { create } from "zustand";
import { v4 as uuidv4 } from "uuid";
import type { ChatMessage, ToolCall, McpTool, HookEvent, PermissionMode } from "../lib/types";
import type { ProviderId } from "../lib/providers";
import { hydrateProviderHistory } from "../lib/providerRuntime";
import type { ProviderHydrateInput } from "../contracts/providerRuntime";

// Keep the persisted key stable for existing installs; the exported
// provider-neutral name is the preferred surface for new callers.
export const PROVIDER_SESSIONS_STORAGE_KEY = "terminal64-claude-sessions";
/** @deprecated Use PROVIDER_SESSIONS_STORAGE_KEY. */
export const STORAGE_KEY = PROVIDER_SESSIONS_STORAGE_KEY;
const STALE_UNNAMED_META_MS = 14 * 24 * 60 * 60 * 1000;
const MAX_PERSISTED_META_ENTRIES = 160;

export interface OpenAiProviderSessionMetadata {
  codexThreadId: string | null;
  selectedCodexPermission: string | null;
}

export interface ProviderSessionMetadataRegistry {
  anthropic: Record<string, never>;
  openai: OpenAiProviderSessionMetadata;
}

export type ProviderSessionMetadataFor<P extends ProviderId> = P extends keyof ProviderSessionMetadataRegistry
  ? ProviderSessionMetadataRegistry[P]
  : Record<string, unknown>;

export type ProviderSessionMetadataMap = Partial<{
  [P in ProviderId]: ProviderSessionMetadataFor<P>;
}>;

export interface ProviderSessionState {
  provider: ProviderId;
  selectedModel: string | null;
  selectedEffort: string | null;
  seedTranscript: ChatMessage[] | null;
  providerMetadata: ProviderSessionMetadataMap;
}

interface ProviderCompatibilityFields {
  provider: ProviderId;
  codexThreadId: string | null;
  seedTranscript: ChatMessage[] | null;
  selectedModel: string | null;
  selectedEffort: string | null;
  selectedCodexPermission: string | null;
}

type ProviderStateSource = {
  providerState?: ProviderSessionState | undefined;
  provider?: ProviderId | undefined;
  providerMetadata?: ProviderSessionMetadataMap | undefined;
  codexThreadId?: string | null | undefined;
  seedTranscript?: ChatMessage[] | null | undefined;
  selectedModel?: string | null | undefined;
  selectedEffort?: string | null | undefined;
  selectedCodexPermission?: string | null | undefined;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function openAiMetadataFromUnknown(
  value: unknown,
  fallback?: Partial<OpenAiProviderSessionMetadata>,
): OpenAiProviderSessionMetadata {
  const record = isRecord(value) ? value : {};
  const codexThreadId = typeof record.codexThreadId === "string" || record.codexThreadId === null
    ? record.codexThreadId
    : fallback?.codexThreadId ?? null;
  const selectedCodexPermission =
    typeof record.selectedCodexPermission === "string" || record.selectedCodexPermission === null
      ? record.selectedCodexPermission
      : fallback?.selectedCodexPermission ?? null;
  return { codexThreadId, selectedCodexPermission };
}

function providerMetadataFromUnknown(value: unknown): ProviderSessionMetadataMap {
  if (!isRecord(value)) return {};
  const metadata = { ...value } as ProviderSessionMetadataMap;
  if (isRecord(value.openai)) {
    metadata.openai = openAiMetadataFromUnknown(value.openai);
  }
  return metadata;
}

function legacyOpenAiMetadataFromProviderState(value: unknown): OpenAiProviderSessionMetadata | null {
  if (!isRecord(value)) return null;
  if (isRecord(value.providerMetadata) && isRecord(value.providerMetadata.openai)) {
    return openAiMetadataFromUnknown(value.providerMetadata.openai);
  }
  if (isRecord(value.openai)) {
    return openAiMetadataFromUnknown(value.openai);
  }
  return null;
}

function createProviderState({
  provider,
  selectedModel,
  selectedEffort,
  seedTranscript,
  providerMetadata,
  codexThreadId,
  selectedCodexPermission,
}: {
  provider: ProviderId;
  selectedModel?: string | null | undefined;
  selectedEffort?: string | null | undefined;
  seedTranscript?: ChatMessage[] | null | undefined;
  providerMetadata?: ProviderSessionMetadataMap | undefined;
  codexThreadId?: string | null | undefined;
  selectedCodexPermission?: string | null | undefined;
}): ProviderSessionState {
  const metadata = providerMetadataFromUnknown(providerMetadata);
  if (provider === "openai") {
    const existingOpenAi = openAiMetadataFromUnknown(metadata.openai);
    metadata.openai = {
      codexThreadId: codexThreadId !== undefined ? codexThreadId : existingOpenAi.codexThreadId,
      selectedCodexPermission: selectedCodexPermission !== undefined
        ? selectedCodexPermission
        : existingOpenAi.selectedCodexPermission,
    };
  }

  return {
    provider,
    selectedModel: selectedModel ?? null,
    selectedEffort: selectedEffort ?? null,
    seedTranscript: seedTranscript ?? null,
    providerMetadata: metadata,
  };
}

export function resolveSessionProviderState(session: ProviderStateSource | null | undefined): ProviderSessionState {
  if (session?.providerState) {
    const legacyOpenAiMetadata = legacyOpenAiMetadataFromProviderState(session.providerState);
    return createProviderState({
      provider: session.providerState.provider,
      selectedModel: session.providerState.selectedModel,
      selectedEffort: session.providerState.selectedEffort,
      seedTranscript: session.providerState.seedTranscript,
      providerMetadata: session.providerState.providerMetadata,
      ...(legacyOpenAiMetadata ? legacyOpenAiMetadata : {}),
    });
  }
  return createProviderState({
    provider: session?.provider ?? "anthropic",
    selectedModel: session?.selectedModel ?? null,
    selectedEffort: session?.selectedEffort ?? null,
    seedTranscript: session?.seedTranscript ?? null,
    providerMetadata: session?.providerMetadata,
    codexThreadId: session?.codexThreadId ?? null,
    selectedCodexPermission: session?.selectedCodexPermission ?? null,
  });
}

export function getProviderSessionMetadata<P extends ProviderId>(
  providerState: ProviderSessionState | null | undefined,
  provider: P,
): ProviderSessionMetadataFor<P> | undefined {
  return providerState?.providerMetadata[provider] as ProviderSessionMetadataFor<P> | undefined;
}

export function resolveProviderSessionMetadata<P extends ProviderId>(
  session: ProviderStateSource | null | undefined,
  provider: P,
): ProviderSessionMetadataFor<P> | undefined {
  return getProviderSessionMetadata(resolveSessionProviderState(session), provider);
}

export function getOpenAiProviderSessionMetadata(
  providerState: ProviderSessionState | null | undefined,
): OpenAiProviderSessionMetadata | undefined {
  return getProviderSessionMetadata(providerState, "openai");
}

export function resolveOpenAiProviderSessionMetadata(
  session: ProviderStateSource | null | undefined,
): OpenAiProviderSessionMetadata | undefined {
  return resolveProviderSessionMetadata(session, "openai");
}

function providerCompatibilityFields(providerState: ProviderSessionState): ProviderCompatibilityFields {
  const openaiMetadata = providerState.provider === "openai"
    ? getOpenAiProviderSessionMetadata(providerState)
    : undefined;
  return {
    provider: providerState.provider,
    codexThreadId: openaiMetadata?.codexThreadId ?? null,
    seedTranscript: providerState.seedTranscript,
    selectedModel: providerState.selectedModel,
    selectedEffort: providerState.selectedEffort,
    selectedCodexPermission: openaiMetadata?.selectedCodexPermission ?? null,
  };
}

function hasOwn<K extends PropertyKey>(value: object, key: K): value is Record<K, unknown> {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function normalizeProviderState(
  base: ProviderSessionState,
  patch: Partial<ProviderCompatibilityFields> & { providerState?: ProviderSessionState },
): ProviderSessionState {
  const source = patch.providerState ?? base;
  const provider = hasOwn(patch, "provider") ? (patch.provider as ProviderId) : source.provider;
  const selectedModel = hasOwn(patch, "selectedModel")
    ? (patch.selectedModel as string | null)
    : source.selectedModel;
  const selectedEffort = hasOwn(patch, "selectedEffort")
    ? (patch.selectedEffort as string | null)
    : source.selectedEffort;
  const seedTranscript = hasOwn(patch, "seedTranscript")
    ? (patch.seedTranscript as ChatMessage[] | null)
    : source.seedTranscript;
  const sourceMetadata = source.providerMetadata ?? {};
  const patchMetadata = hasOwn(patch, "providerMetadata")
    ? (patch.providerMetadata as ProviderSessionMetadataMap | undefined)
    : undefined;
  const providerMetadata = patchMetadata ? { ...sourceMetadata, ...patchMetadata } : sourceMetadata;
  const sourceOpenAiMetadata = getOpenAiProviderSessionMetadata(source);
  const codexThreadId = hasOwn(patch, "codexThreadId")
    ? (patch.codexThreadId as string | null)
    : sourceOpenAiMetadata?.codexThreadId ?? null;
  const selectedCodexPermission = hasOwn(patch, "selectedCodexPermission")
    ? (patch.selectedCodexPermission as string | null)
    : sourceOpenAiMetadata?.selectedCodexPermission ?? null;

  return createProviderState({
    provider,
    selectedModel,
    selectedEffort,
    seedTranscript,
    providerMetadata,
    codexThreadId,
    selectedCodexPermission,
  });
}

// localStorage stores only lightweight provider-session UI metadata. Messages
// and token/cost counters are derived from each provider's history backend, so
// wiping localStorage must never lose chat history; dropping this metadata costs
// only a draft prompt and a friendly name.
export interface PersistedSessionMeta {
  sessionId: string;
  name: string;
  cwd: string;
  draftPrompt: string;
  lastSeenAt: number;
  schemaVersion: number;
  providerState?: ProviderSessionState;
  provider?: ProviderId;
  codexThreadId?: string | null;
  // Pre-rendered transcript inherited from a parent session when native
  // provider fork is unavailable. Persisted so a reload before the first turn
  // doesn't lose the seed.
  seedTranscript?: ChatMessage[];
  // Per-session model + reasoning-effort, persisted so flipping models in
  // one chat doesn't bleed into other sessions and so a reload restores the
  // user's pick. Null/undefined falls back to settings-store defaults.
  // (Distinct from `ProviderSession.model` which is the runtime-reported value
  // from the provider's init/start event.)
  selectedModel?: string | null;
  selectedEffort?: string | null;
  // Codex sandbox/approval preset id ("read-only" | "workspace" | "full-auto"
  // | "yolo"). Anthropic sessions cycle their permission mode mid-flight via
  // the topbar Shift+Tab handler; Codex doesn't have an equivalent so the
  // chosen preset is what we re-send on each `codex exec resume`.
  selectedCodexPermission?: string | null;
}

// Bump when the shape of PersistedSessionMeta changes. Older clients that
// encounter a higher version refuse to overwrite — see downgradeLockActive.
const CURRENT_SCHEMA_VERSION = 5;

// Flips true once we see persisted data written by a newer schema than we
// understand. While active, saveToStorage is a no-op so a downgraded client
// can't clobber data the next rollforward relies on.
let downgradeLockActive = false;
let persistedMetaCache: Record<string, PersistedSessionMeta> | null = null;
let lastPersistedMetaJson: string | null = null;

export interface ProviderTask {
  id: string;
  subject: string;
  description?: string;
  status: "pending" | "in_progress" | "completed" | "deleted";
}

/** @deprecated Use ProviderTask. */
export type ClaudeTask = ProviderTask;

export interface QuestionOption {
  label: string;
  description?: string;
}

export interface PendingQuestionItem {
  question: string;
  header?: string;
  options: QuestionOption[];
  multiSelect?: boolean;
}

export interface PendingQuestions {
  toolUseId: string;
  items: PendingQuestionItem[];
  currentIndex: number;
  answers: string[];
}

export interface PendingPermission {
  requestId: string;
  toolName: string;
  toolInput: Record<string, unknown>;
}

export type QueuedPromptCommandKind =
  | "plain"
  | "slash"
  | "compact"
  | "codex-plan"
  | "plan-build"
  | "delegation-merge"
  | "delegation-forward"
  | "delegate-plan"
  | "skill"
  | "reload"
  | "loop";

export interface QueuedPromptCommandMetadata {
  kind: QueuedPromptCommandKind;
  name?: string | undefined;
  originalText?: string | undefined;
  sourceSessionId?: string | undefined;
  groupId?: string | undefined;
}

export interface QueuedPromptAttachmentState {
  expanded: boolean;
  files: string[];
}

export interface QueuedPromptInput {
  displayText: string;
  providerPrompt?: string | undefined;
  permissionOverride?: PermissionMode | undefined;
  codexCollaborationMode?: "plan" | "default" | undefined;
  attachmentState?: QueuedPromptAttachmentState | undefined;
  command?: QueuedPromptCommandMetadata | undefined;
}

export interface QueuedPrompt {
  id: string;
  displayText: string;
  providerPrompt: string;
  timestamp: number;
  permissionOverride?: PermissionMode | undefined;
  codexCollaborationMode?: "plan" | "default" | undefined;
  attachmentState?: QueuedPromptAttachmentState | undefined;
  command?: QueuedPromptCommandMetadata | undefined;
  /** @deprecated legacy in-memory queue entries used text-only payloads. */
  text?: string | undefined;
}

export function queuedPromptDisplayText(prompt: QueuedPrompt): string {
  const legacy = prompt as QueuedPrompt & {
    displayText?: string | undefined;
    providerPrompt?: string | undefined;
    text?: string | undefined;
  };
  return legacy.displayText ?? legacy.text ?? legacy.providerPrompt ?? "";
}

export function queuedPromptProviderPrompt(prompt: QueuedPrompt): string {
  const legacy = prompt as QueuedPrompt & {
    displayText?: string | undefined;
    providerPrompt?: string | undefined;
    text?: string | undefined;
  };
  return legacy.providerPrompt ?? legacy.text ?? legacy.displayText ?? "";
}

function createQueuedPrompt(input: string | QueuedPromptInput): QueuedPrompt {
  if (typeof input === "string") {
    return {
      id: uuidv4(),
      displayText: input,
      providerPrompt: input,
      timestamp: Date.now(),
    };
  }

  return {
    id: uuidv4(),
    displayText: input.displayText,
    providerPrompt: input.providerPrompt ?? input.displayText,
    timestamp: Date.now(),
    ...(input.permissionOverride !== undefined ? { permissionOverride: input.permissionOverride } : {}),
    ...(input.codexCollaborationMode !== undefined ? { codexCollaborationMode: input.codexCollaborationMode } : {}),
    ...(input.attachmentState !== undefined ? { attachmentState: input.attachmentState } : {}),
    ...(input.command !== undefined ? { command: input.command } : {}),
  };
}

export interface McpServerStatus {
  name: string;
  status: string;
  error?: string;
  transport?: string;
  scope?: string;
  tools?: McpTool[];
  toolCount?: number;
}

export interface ProviderSession {
  sessionId: string;
  messages: ChatMessage[];
  tasks: ProviderTask[];
  isStreaming: boolean;
  streamingText: string;
  streamingStartedAt: number | null;
  lastEventAt: number | null;
  model: string;
  totalCost: number;
  totalTokens: number;
  contextUsed: number;
  contextMax: number;
  error: string | null;
  promptCount: number;
  planModeActive: boolean;
  pendingQuestions: PendingQuestions | null;
  pendingPermission: PendingPermission | null;
  name: string;
  cwd: string;
  promptQueue: QueuedPrompt[];
  hasBeenStarted: boolean;
  draftPrompt: string;
  activeLoop: ActiveLoop | null;
  ephemeral: boolean;
  mcpServers: McpServerStatus[];
  modifiedFiles: string[];
  autoCompactStatus: "idle" | "compacting" | "done";
  autoCompactStartedAt: number | null;
  resumeAtUuid: string | null;
  forkParentSessionId: string | null;
  skipOpenwolf: boolean;
  toolUsageStats: Record<string, number>;
  compactionCount: number;
  subagentIds: string[];
  hookEventLog: HookEvent[];
  // True once the JSONL on disk has been loaded (or load attempted and failed).
  // UI uses this to know when it's safe to claim "no messages" vs "still loading".
  jsonlLoaded: boolean;
  // Canonical provider-owned metadata. New provider integrations should add
  // provider-specific state here instead of widening the flat session shape.
  providerState: ProviderSessionState;
  // Which backend CLI this session is bound to. Existing sessions hydrated
  // from older metadata default to "anthropic" for backward compatibility.
  /** @deprecated Use providerState.provider. Kept as a compatibility mirror. */
  provider: ProviderId;
  // Codex's CLI mints its own thread id on `thread.started`; we capture it
  // here so follow-up `codex exec resume <id>` calls can find the thread.
  // Always null for anthropic sessions.
  /** @deprecated Use getOpenAiProviderSessionMetadata(providerState)?.codexThreadId. */
  codexThreadId: string | null;
  // Fork-time prelude. When non-null, these messages were rendered into
  // `messages` at session-create time; the send path may also splice them
  // into the first prompt sent to a freshly-spawned Codex thread so the
  // model has the parent's context. Null for normal (non-forked) sessions.
  /** @deprecated Use providerState.seedTranscript. */
  seedTranscript: ChatMessage[] | null;
  // Per-session model + reasoning effort. Null = "use the settings-store
  // default for this session's provider". The topbar dropdowns read these,
  // and selecting a new value writes back via setSessionModel/setSessionEffort
  // so the choice survives reloads. Different from the existing `model` field
  // above, which is the CLI's runtime-reported active model.
  /** @deprecated Use providerState.selectedModel. */
  selectedModel: string | null;
  /** @deprecated Use providerState.selectedEffort. */
  selectedEffort: string | null;
  // Codex sandbox/approval preset id. Null on Anthropic sessions; defaults
  // to PROVIDER_CONFIG.openai.defaultPermission for OpenAI.
  /** @deprecated Use getOpenAiProviderSessionMetadata(providerState)?.selectedCodexPermission. */
  selectedCodexPermission: string | null;
}

/** @deprecated Use ProviderSession. */
export type ClaudeSession = ProviderSession;

export interface ActiveLoop {
  prompt: string;
  intervalMs: number;
  lastFiredAt: number | null;
  iteration: number;
}

export interface ProviderSessionStoreState {
  sessions: Record<string, ProviderSession>;

  createSession: (
    sessionId: string,
    initialName?: string,
    ephemeral?: boolean,
    skipOpenwolf?: boolean,
    cwd?: string,
    provider?: ProviderId,
  ) => void;
  setCodexThreadId: (sessionId: string, threadId: string | null) => void;
  setSeedTranscript: (sessionId: string, messages: ChatMessage[]) => void;
  clearSeedTranscript: (sessionId: string) => void;
  setSelectedModel: (sessionId: string, model: string | null) => void;
  setSelectedEffort: (sessionId: string, effort: string | null) => void;
  setSelectedCodexPermission: (sessionId: string, permission: string | null) => void;
  removeSession: (sessionId: string) => void;
  addUserMessage: (sessionId: string, text: string) => void;
  appendStreamingText: (sessionId: string, text: string) => void;
  clearStreamingText: (sessionId: string) => void;
  finalizeAssistantMessage: (sessionId: string, text: string, toolCalls?: ToolCall[]) => void;
  updateToolCall: (sessionId: string, toolUseId: string, patch: Partial<ToolCall>) => void;
  updateToolResult: (sessionId: string, toolUseId: string, result: string, isError: boolean, patch?: Partial<ToolCall>) => void;
  setStreaming: (sessionId: string, streaming: boolean) => void;
  touchLastEvent: (sessionId: string) => void;
  setModel: (sessionId: string, model: string) => void;
  addCost: (sessionId: string, cost: number) => void;
  addTokens: (sessionId: string, tokens: number) => void;
  setContextUsage: (sessionId: string, used: number, max: number) => void;
  setError: (sessionId: string, error: string | null) => void;
  incrementPromptCount: (sessionId: string) => void;
  addTask: (sessionId: string, task: ProviderTask) => void;
  updateTask: (sessionId: string, taskId: string, update: Partial<ProviderTask>) => void;
  setPlanMode: (sessionId: string, active: boolean) => void;
  setPendingQuestions: (sessionId: string, questions: PendingQuestions | null) => void;
  setPendingPermission: (sessionId: string, permission: PendingPermission | null) => void;
  answerQuestion: (sessionId: string, answer: string) => void;
  setName: (sessionId: string, name: string) => void;
  setCwd: (sessionId: string, cwd: string) => void;
  setMcpServers: (sessionId: string, servers: McpServerStatus[]) => void;
  enqueuePrompt: (sessionId: string, prompt: string | QueuedPromptInput) => void;
  dequeuePrompt: (sessionId: string) => QueuedPrompt | undefined;
  removeQueuedPrompt: (sessionId: string, promptId: string) => void;
  clearQueue: (sessionId: string) => void;
  loadFromDisk: (sessionId: string, messages: ChatMessage[]) => void;
  replaceFromDisk: (sessionId: string, messages: ChatMessage[]) => void;
  refreshFromHistory: (sessionId: string, cwd: string) => Promise<void>;
  mergeFromDisk: (sessionId: string, messages: ChatMessage[]) => void;
  setDraftPrompt: (sessionId: string, text: string) => void;
  setLoop: (sessionId: string, loop: ActiveLoop | null) => void;
  tickLoop: (sessionId: string) => void;
  addModifiedFiles: (sessionId: string, paths: string[]) => void;
  resetModifiedFiles: (sessionId: string) => void;
  deleteSession: (sessionId: string) => void;
  setAutoCompactStatus: (sessionId: string, status: "idle" | "compacting" | "done") => void;
  setResumeAtUuid: (sessionId: string, uuid: string | null) => void;
  setForkParentSessionId: (sessionId: string, parentId: string | null) => void;
  truncateFromMessage: (sessionId: string, messageId: string) => void;
  addHookEvent: (sessionId: string, event: HookEvent) => void;
  recordToolUsage: (sessionId: string, toolName: string) => void;
  incrementCompactionCount: (sessionId: string) => void;
  addSubagent: (sessionId: string, subagentId: string) => void;
  removeSubagent: (sessionId: string, subagentId: string) => void;
}

/** @deprecated Use ProviderSessionStoreState. */
export type ClaudeState = ProviderSessionStoreState;

function updateSession(
  sessions: Record<string, ProviderSession>,
  sessionId: string,
  update: Partial<ProviderSession>
): Record<string, ProviderSession> {
  const session = sessions[sessionId];
  if (!session) return sessions;
  const baseProviderState = resolveSessionProviderState(session);
  const providerState = normalizeProviderState(baseProviderState, update);
  return {
    ...sessions,
    [sessionId]: {
      ...session,
      ...update,
      providerState,
      ...providerCompatibilityFields(providerState),
    },
  };
}

type IdleDeadlineLike = { didTimeout: boolean; timeRemaining: () => number };
type WindowWithIdleCallback = Window & typeof globalThis & {
  requestIdleCallback?: (callback: (deadline: IdleDeadlineLike) => void, options?: { timeout: number }) => number;
  cancelIdleCallback?: (handle: number) => void;
};

function scheduleIdle(callback: () => void): number {
  const w = window as WindowWithIdleCallback;
  if (typeof w.requestIdleCallback === "function") {
    return w.requestIdleCallback(() => callback(), { timeout: 2000 });
  }
  return window.setTimeout(callback, 0);
}

function cancelIdle(handle: number) {
  const w = window as WindowWithIdleCallback;
  if (typeof w.cancelIdleCallback === "function") {
    w.cancelIdleCallback(handle);
  } else {
    window.clearTimeout(handle);
  }
}

function clonePersistedMeta(data: Record<string, PersistedSessionMeta>): Record<string, PersistedSessionMeta> {
  return { ...data };
}

function readPersistedMeta(): Record<string, PersistedSessionMeta> {
  if (persistedMetaCache) return clonePersistedMeta(persistedMetaCache);

  let raw: string | null = null;
  try {
    raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return {};
    const data = parsed as Record<string, PersistedSessionMeta>;
    // Forward-compat guard: if any entry was written by a newer schema, flip
    // the read-only flag so we don't silently downgrade it on the next write.
    if (!downgradeLockActive) {
      for (const entry of Object.values(data)) {
        const v = (entry as { schemaVersion?: number })?.schemaVersion ?? 0;
        if (v > CURRENT_SCHEMA_VERSION) {
          console.warn(
            `[claudeStore] Persisted metadata schemaVersion ${v} exceeds supported ${CURRENT_SCHEMA_VERSION}. ` +
              "Entering read-only mode to avoid downgrading newer data.",
          );
          downgradeLockActive = true;
          break;
        }
      }
    }
    persistedMetaCache = data;
    lastPersistedMetaJson = raw;
    return data;
  } catch (e) {
    // Parse failure: back up the raw bytes so a corrupted blob is still
    // recoverable (names, drafts). Then return empty so the app keeps working.
    if (raw) {
      try {
        const backup = { savedAt: new Date().toISOString(), raw };
        localStorage.setItem(`${STORAGE_KEY}.bak`, JSON.stringify(backup));
        console.warn(
          `[claudeStore] Corrupt metadata in localStorage — raw bytes backed up to "${STORAGE_KEY}.bak" before recovery.`,
          e,
        );
      } catch (backupErr) {
        console.warn("[claudeStore] Failed to back up corrupt metadata:", backupErr);
      }
    } else {
      console.warn("[claudeStore] Failed to parse persisted metadata:", e);
    }
    return {};
  }
}

function writePersistedMeta(data: Record<string, PersistedSessionMeta>) {
  const json = JSON.stringify(data);
  if (json === lastPersistedMetaJson) return;
  localStorage.setItem(STORAGE_KEY, json);
  persistedMetaCache = data;
  lastPersistedMetaJson = json;
}

function deletePersistedMeta(sessionId: string) {
  const data = readPersistedMeta();
  if (!data[sessionId]) return;
  delete data[sessionId];
  writePersistedMeta(data);
}

function prunePersistedMeta(
  data: Record<string, PersistedSessionMeta>,
  activeSessionIds: Set<string>,
  now: number,
  aggressive: boolean,
): Record<string, PersistedSessionMeta> {
  for (const [id, row] of Object.entries(data)) {
    if (!row || row.name?.startsWith("[D] ")) {
      delete data[id];
      continue;
    }
    const isActive = activeSessionIds.has(id);
    const isUnnamed = !row.name?.trim();
    if (!isActive && isUnnamed && now - (row.lastSeenAt || 0) > STALE_UNNAMED_META_MS) {
      delete data[id];
    }
  }

  const entries = Object.entries(data);
  if (entries.length <= MAX_PERSISTED_META_ENTRIES && !aggressive) return data;

  const removable = entries
    .filter(([id]) => !activeSessionIds.has(id))
    .sort((a, b) => (a[1].lastSeenAt || 0) - (b[1].lastSeenAt || 0));
  let overage = Math.max(0, entries.length - MAX_PERSISTED_META_ENTRIES);
  for (const [id, row] of removable) {
    if (overage <= 0 && (!aggressive || row.name?.trim())) break;
    delete data[id];
    overage--;
  }
  return data;
}

function providerStateFromPersistedMeta(entry: PersistedSessionMeta): ProviderSessionState {
  const legacyProvider: ProviderId = entry.provider === "openai" ? "openai" : "anthropic";
  const savedState = entry.providerState;
  const provider: ProviderId = savedState?.provider === "openai" ? "openai" : legacyProvider;
  const savedOpenAiMetadata = legacyOpenAiMetadataFromProviderState(savedState);
  const selectedModel = typeof savedState?.selectedModel === "string"
    ? savedState.selectedModel
    : typeof entry.selectedModel === "string"
      ? entry.selectedModel
      : null;
  const selectedEffort = typeof savedState?.selectedEffort === "string"
    ? savedState.selectedEffort
    : typeof entry.selectedEffort === "string"
      ? entry.selectedEffort
      : null;
  const seedTranscript = Array.isArray(savedState?.seedTranscript)
    ? savedState.seedTranscript
    : Array.isArray(entry.seedTranscript)
      ? entry.seedTranscript
      : null;
  const codexThreadId = savedOpenAiMetadata?.codexThreadId ?? entry.codexThreadId ?? null;
  const selectedCodexPermission =
    savedOpenAiMetadata?.selectedCodexPermission ??
    (typeof entry.selectedCodexPermission === "string" ? entry.selectedCodexPermission : null);

  return createProviderState({
    provider,
    selectedModel,
    selectedEffort,
    seedTranscript,
    providerMetadata: providerMetadataFromUnknown(savedState?.providerMetadata),
    codexThreadId,
    selectedCodexPermission,
  });
}

function buildPersistedMeta(
  sessions: Record<string, ProviderSession>,
  dropSeedTranscripts: boolean,
  aggressivePrune: boolean,
): Record<string, PersistedSessionMeta> {
  const existing = readPersistedMeta();
  const next = clonePersistedMeta(existing);
  const activeSessionIds = new Set<string>();
  const now = Date.now();

  for (const [id, s] of Object.entries(sessions)) {
    if (s.ephemeral) continue;
    activeSessionIds.add(id);
    const baseProviderState = resolveSessionProviderState(s);
    const providerState = normalizeProviderState(baseProviderState, s);
    const persistedProviderState = dropSeedTranscripts
      ? { ...providerState, seedTranscript: null }
      : providerState;
    const compat = providerCompatibilityFields(persistedProviderState);
    next[id] = {
      sessionId: s.sessionId,
      name: s.name,
      cwd: s.cwd,
      draftPrompt: s.draftPrompt || "",
      lastSeenAt: now,
      schemaVersion: CURRENT_SCHEMA_VERSION,
      providerState: persistedProviderState,
      provider: compat.provider,
      codexThreadId: compat.codexThreadId,
      ...(!dropSeedTranscripts && compat.seedTranscript ? { seedTranscript: compat.seedTranscript } : {}),
      ...(compat.selectedModel ? { selectedModel: compat.selectedModel } : {}),
      ...(compat.selectedEffort ? { selectedEffort: compat.selectedEffort } : {}),
      ...(compat.selectedCodexPermission ? { selectedCodexPermission: compat.selectedCodexPermission } : {}),
    };
  }

  return prunePersistedMeta(next, activeSessionIds, now, aggressivePrune);
}

function loadMetadata(sessionId: string): PersistedSessionMeta | null {
  const data = readPersistedMeta();
  const entry = data[sessionId];
  if (!entry) return null;
  const providerState = providerStateFromPersistedMeta(entry);
  const compat = providerCompatibilityFields(providerState);
  return {
    sessionId: entry.sessionId || sessionId,
    name: entry.name || "",
    cwd: entry.cwd || "",
    draftPrompt: entry.draftPrompt || "",
    lastSeenAt: entry.lastSeenAt || 0,
    schemaVersion: (entry as { schemaVersion?: number }).schemaVersion ?? 0,
    providerState,
    provider: compat.provider,
    codexThreadId: compat.codexThreadId,
    // v2 blobs lack seedTranscript — leave undefined so consumers treat the
    // session as un-seeded. Stored as ChatMessage[] when present.
    ...(compat.seedTranscript ? { seedTranscript: compat.seedTranscript } : {}),
    // v3 and earlier didn't carry per-session model/effort; v4+ does.
    selectedModel: compat.selectedModel,
    selectedEffort: compat.selectedEffort,
    selectedCodexPermission: compat.selectedCodexPermission,
  };
}

// Write only lightweight metadata. Messages live in JSONL and are reloaded on
// demand, so this payload stays small and cannot exhaust the storage quota.
function saveToStorage(sessions: Record<string, ProviderSession>) {
  if (downgradeLockActive) return;
  try {
    const data = buildPersistedMeta(sessions, false, false);
    // readPersistedMeta may have flipped the lock on a newer-schema read.
    if (downgradeLockActive) return;
    writePersistedMeta(data);
  } catch (e) {
    try {
      // Quota fallback: preserve session rows and current choices, but drop
      // fork seed transcripts and prune old inactive rows before retrying.
      writePersistedMeta(buildPersistedMeta(sessions, true, true));
      console.warn("[claudeStore] Saved compact metadata after localStorage quota pressure:", e);
    } catch (retryErr) {
      console.error("[claudeStore] Failed to save session metadata:", retryErr);
    }
  }
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;
let idleSaveHandle: number | null = null;
let savePending = false;

function scheduleIdleSave() {
  if (idleSaveHandle !== null) return;
  idleSaveHandle = scheduleIdle(() => {
    idleSaveHandle = null;
    if (!savePending) return;
    savePending = false;
    saveToStorage(useClaudeStore.getState().sessions);
    if (savePending) scheduleIdleSave();
  });
}

function debouncedSave() {
  savePending = true;
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    scheduleIdleSave();
  }, 1000);
}

function patchSession(sessionId: string, patch: Partial<ProviderSession>) {
  useClaudeStore.setState((s) => ({ sessions: updateSession(s.sessions, sessionId, patch) }));
}

// In-memory hydration cache keyed by {mtime_ms, size}. Reloading the same
// session within one app session is common (switching chat tabs, re-opening a
// dialog) — if the JSONL hasn't changed, reuse the parsed messages instead of
// streaming 10k records over IPC + reparsing in Rust. Not persisted: a process
// restart will always do a fresh parse.
interface HydrationCacheEntry {
  mtimeMs: number;
  size: number;
  messages: ChatMessage[];
  lastUsedAt: number;
}
const hydrationCache = new Map<string, HydrationCacheEntry>();
const MAX_HYDRATION_CACHE_ENTRIES = 6;
const MAX_HYDRATION_CACHE_MESSAGES = 30000;

function trimHydrationCache() {
  let totalMessages = 0;
  for (const entry of hydrationCache.values()) totalMessages += entry.messages.length;
  if (hydrationCache.size <= MAX_HYDRATION_CACHE_ENTRIES && totalMessages <= MAX_HYDRATION_CACHE_MESSAGES) return;

  const oldest = [...hydrationCache.entries()].sort((a, b) => a[1].lastUsedAt - b[1].lastUsedAt);
  for (const [sessionId, entry] of oldest) {
    if (hydrationCache.size <= MAX_HYDRATION_CACHE_ENTRIES && totalMessages <= MAX_HYDRATION_CACHE_MESSAGES) break;
    hydrationCache.delete(sessionId);
    totalMessages -= entry.messages.length;
  }
}

function rememberHydration(sessionId: string, mtimeMs: number, size: number, messages: ChatMessage[]) {
  hydrationCache.set(sessionId, {
    mtimeMs,
    size,
    messages,
    lastUsedAt: Date.now(),
  });
  trimHydrationCache();
}

function buildProviderHydrateInput(sessionId: string, cwd: string): ProviderHydrateInput | null {
  const sess = useClaudeStore.getState().sessions[sessionId];
  if (!sess) return null;
  const providerState = resolveSessionProviderState(sess);
  const provider = providerState.provider;
  const codexThreadId = getOpenAiProviderSessionMetadata(providerState)?.codexThreadId ?? sess?.codexThreadId ?? null;
  const input: ProviderHydrateInput = {
    provider,
    sessionId,
    cwd,
  };
  if (sess.resumeAtUuid) {
    input.resumeAtUuid = sess.resumeAtUuid;
  }
  if (codexThreadId !== undefined) {
    input.codexThreadId = codexThreadId;
  }
  const cached = hydrationCache.get(sessionId);
  if (cached) {
    cached.lastUsedAt = Date.now();
    input.cacheEntry = cached;
  }
  return input;
}

async function hydrateSessionHistory(
  sessionId: string,
  cwd: string,
  mode: "extend" | "replace",
): Promise<void> {
  const input = buildProviderHydrateInput(sessionId, cwd);
  if (!input) return;
  try {
    const result = await hydrateProviderHistory(input);
    if (result.clearCache) {
      hydrationCache.delete(sessionId);
    }
    if (result.status === "messages") {
      if (result.cacheWrite) {
        rememberHydration(
          sessionId,
          result.cacheWrite.mtimeMs,
          result.cacheWrite.size,
          result.cacheWrite.messages,
        );
      }
      if (mode === "replace") {
        useClaudeStore.getState().replaceFromDisk(sessionId, result.messages);
      } else {
        useClaudeStore.getState().loadFromDisk(sessionId, result.messages);
      }
    } else {
      patchSession(sessionId, { jsonlLoaded: true });
    }
  } catch (err) {
    const label = input.provider === "openai" ? "Codex" : "JSONL";
    console.warn(`[claudeStore] ${label} hydrate failed:`, sessionId, err);
    patchSession(sessionId, { jsonlLoaded: true });
    throw err;
  }
}

// Async provider history hydration. Fire-and-forget — errors are logged but
// non-fatal so the user can still interact with a session whose history hasn't
// loaded yet.
function hydrateFromJsonl(sessionId: string, cwd: string) {
  hydrateSessionHistory(sessionId, cwd, "extend").catch(() => {});
}


const providerSessionStore = create<ProviderSessionStoreState>((set, get) => ({
  sessions: {},

  createSession: (sessionId, initialName, ephemeral, skipOpenwolf, cwd, provider) => {
    const existing = get().sessions[sessionId];
    if (existing) {
      if (initialName && !existing.name) {
        set((s) => {
          const updated = updateSession(s.sessions, sessionId, { name: initialName });
          if (!existing.ephemeral) saveToStorage(updated);
          return { sessions: updated };
        });
      }
      // If caller supplied a cwd and we didn't have one, adopt it and hydrate.
      if (cwd && !existing.cwd && !existing.ephemeral) {
        set((s) => {
          const updated = updateSession(s.sessions, sessionId, { cwd });
          saveToStorage(updated);
          return { sessions: updated };
        });
        if (!existing.jsonlLoaded) hydrateFromJsonl(sessionId, cwd);
      }
      return;
    }

    const meta = ephemeral ? null : loadMetadata(sessionId);
    const seededName = initialName ?? meta?.name ?? "";
    const seededCwd = cwd ?? meta?.cwd ?? "";
    const seededDraft = meta?.draftPrompt ?? "";
    const metaProviderState = meta?.providerState;
    const seededProvider: ProviderId = provider ?? metaProviderState?.provider ?? meta?.provider ?? "anthropic";
    const metaOpenAiMetadata = getOpenAiProviderSessionMetadata(metaProviderState);
    const seededCodexThreadId = metaOpenAiMetadata?.codexThreadId ?? meta?.codexThreadId ?? null;
    // Fork plumbing: a parent session can stash a transcript in metadata
    // before the child is created. We pre-render those messages so the UI
    // shows the inherited history immediately; the actual model context for
    // a Codex thread gets restitched into the first prompt by the send path.
    const seededTranscript: ChatMessage[] | null = Array.isArray(metaProviderState?.seedTranscript) && metaProviderState.seedTranscript.length > 0
      ? metaProviderState.seedTranscript
      : Array.isArray(meta?.seedTranscript) && meta.seedTranscript.length > 0
        ? meta.seedTranscript
        : null;
    const seededMessages: ChatMessage[] = seededTranscript ? [...seededTranscript] : [];
    const seededPromptCount = seededMessages.filter((m) => m.role === "user").length;
    const seededSelectedModel = metaProviderState?.selectedModel ?? meta?.selectedModel ?? null;
    const seededSelectedEffort = metaProviderState?.selectedEffort ?? meta?.selectedEffort ?? null;
    const seededSelectedCodexPermission =
      metaOpenAiMetadata?.selectedCodexPermission ?? meta?.selectedCodexPermission ?? null;
    const seededProviderState = createProviderState({
      provider: seededProvider,
      selectedModel: seededSelectedModel,
      selectedEffort: seededSelectedEffort,
      seedTranscript: seededTranscript,
      providerMetadata: metaProviderState?.providerMetadata,
      codexThreadId: seededCodexThreadId,
      selectedCodexPermission: seededSelectedCodexPermission,
    });
    const seededProviderCompat = providerCompatibilityFields(seededProviderState);

    set((s) => {
      const sessions = {
        ...s.sessions,
        [sessionId]: {
          sessionId,
          messages: seededMessages,
          tasks: [],
          isStreaming: false,
          streamingText: "",
          streamingStartedAt: null,
          lastEventAt: null,
          model: "",
          totalCost: 0,
          totalTokens: 0,
          contextUsed: 0,
          contextMax: 0,
          error: null,
          promptCount: seededPromptCount,
          planModeActive: false,
          pendingQuestions: null,
          pendingPermission: null,
          name: seededName,
          cwd: seededCwd,
          promptQueue: [],
          hasBeenStarted: false,
          draftPrompt: seededDraft,
          activeLoop: null,
          ephemeral: !!ephemeral,
          mcpServers: [],
          modifiedFiles: [],
          autoCompactStatus: "idle" as const,
          autoCompactStartedAt: null,
          resumeAtUuid: null,
          forkParentSessionId: null,
          skipOpenwolf: !!skipOpenwolf,
          toolUsageStats: {},
          compactionCount: 0,
          subagentIds: [],
          hookEventLog: [],
          jsonlLoaded: !!ephemeral, // ephemeral sessions never load from disk
          providerState: seededProviderState,
          ...seededProviderCompat,
        },
      };
      if (!ephemeral) debouncedSave();
      return { sessions };
    });

    // Kick off JSONL hydration when we know where to look. Ephemeral and
    // cwd-less sessions skip this; the provider chat shell calls createSession
    // again with a cwd (or calls setCwd) once the panel mounts with its working dir.
    if (!ephemeral && seededCwd) {
      hydrateFromJsonl(sessionId, seededCwd);
    }
  },

  removeSession: (sessionId) => {
    hydrationCache.delete(sessionId);
    set((s) => {
      const removed = s.sessions[sessionId];
      const { [sessionId]: _, ...rest } = s.sessions;
      // Only unnamed or ephemeral sessions get purged from disk. Named sessions
      // remain in metadata so the provider-session dialog can reopen them with
      // history pulled back from the provider backend.
      if (!removed?.name || removed?.ephemeral) {
        try {
          deletePersistedMeta(sessionId);
        } catch (e) {
          console.warn("[claudeStore] Failed to prune metadata on remove:", e);
        }
      }
      return { sessions: rest };
    });
  },

  addUserMessage: (sessionId, text) => {
    set((s) => {
      const session = s.sessions[sessionId];
      if (!session) return s;
      const msg: ChatMessage = { id: uuidv4(), role: "user", content: text, timestamp: Date.now() };
      return { sessions: updateSession(s.sessions, sessionId, { messages: [...session.messages, msg], error: null }) };
    });
  },

  appendStreamingText: (sessionId, text) => {
    set((s) => {
      const session = s.sessions[sessionId];
      if (!session) return s;
      return { sessions: updateSession(s.sessions, sessionId, { streamingText: session.streamingText + text }) };
    });
  },

  clearStreamingText: (sessionId) => {
    set((s) => {
      const session = s.sessions[sessionId];
      if (!session || session.streamingText === "") return s;
      return { sessions: updateSession(s.sessions, sessionId, { streamingText: "" }) };
    });
  },

  finalizeAssistantMessage: (sessionId, text, toolCalls) => {
    set((s) => {
      const session = s.sessions[sessionId];
      if (!session) return s;
      const msg: ChatMessage = {
        id: uuidv4(),
        role: "assistant",
        content: text,
        timestamp: Date.now(),
        ...(toolCalls !== undefined && { toolCalls }),
      };
      return { sessions: updateSession(s.sessions, sessionId, { messages: [...session.messages, msg], streamingText: "" }) };
    });
  },

  updateToolCall: (sessionId, toolUseId, patch) => {
    set((s) => {
      const session = s.sessions[sessionId];
      if (!session) return s;

      const msgs = session.messages;
      for (let i = msgs.length - 1; i >= 0; i--) {
        const msg = msgs[i];
        if (msg && msg.role === "assistant" && msg.toolCalls) {
          const tcIdx = msg.toolCalls.findIndex((t) => t.id === toolUseId);
          if (tcIdx >= 0) {
            const updatedToolCalls = msg.toolCalls.slice();
            const existing = updatedToolCalls[tcIdx]!;
            updatedToolCalls[tcIdx] = {
              ...existing,
              ...patch,
              input: patch.input ? { ...existing.input, ...patch.input } : existing.input,
            };
            const messages = msgs.slice();
            messages[i] = { ...msg, toolCalls: updatedToolCalls };
            return { sessions: updateSession(s.sessions, sessionId, { messages }) };
          }
        }
      }
      return s;
    });
  },

  updateToolResult: (sessionId, toolUseId, result, isError, patch) => {
    set((s) => {
      const session = s.sessions[sessionId];
      if (!session) return s;

      const msgs = session.messages;
      for (let i = msgs.length - 1; i >= 0; i--) {
        const msg = msgs[i];
        if (msg && msg.role === "assistant" && msg.toolCalls) {
          const tcIdx = msg.toolCalls.findIndex((t) => t.id === toolUseId);
          if (tcIdx >= 0) {
            const updatedToolCalls = msg.toolCalls.slice();
            const existing = updatedToolCalls[tcIdx]!;
            updatedToolCalls[tcIdx] = {
              ...existing,
              ...patch,
              input: patch?.input ? { ...existing.input, ...patch.input } : existing.input,
              result,
              isError,
            };
            const messages = msgs.slice();
            messages[i] = { ...msg, toolCalls: updatedToolCalls };
            return { sessions: updateSession(s.sessions, sessionId, { messages }) };
          }
        }
      }
      return s;
    });
  },

  setStreaming: (sessionId, streaming) => {
    set((s) => {
      const session = s.sessions[sessionId];
      if (!session || session.isStreaming === streaming) return s;
      return { sessions: updateSession(s.sessions, sessionId, {
        isStreaming: streaming,
        streamingStartedAt: streaming ? Date.now() : null,
        lastEventAt: streaming ? Date.now() : null,
      }) };
    });
  },

  touchLastEvent: (sessionId) => {
    set((s) => {
      const session = s.sessions[sessionId];
      if (!session) return s;
      return { sessions: updateSession(s.sessions, sessionId, { lastEventAt: Date.now() }) };
    });
  },

  setModel: (sessionId, model) => {
    set((s) => ({ sessions: updateSession(s.sessions, sessionId, { model }) }));
  },

  addCost: (sessionId, cost) => {
    set((s) => {
      const session = s.sessions[sessionId];
      if (!session) return s;
      return { sessions: updateSession(s.sessions, sessionId, { totalCost: session.totalCost + cost }) };
    });
  },

  addTokens: (sessionId, tokens) => {
    set((s) => {
      const session = s.sessions[sessionId];
      if (!session) return s;
      return { sessions: updateSession(s.sessions, sessionId, { totalTokens: session.totalTokens + tokens }) };
    });
  },

  setContextUsage: (sessionId, used, max) => {
    const sess = get().sessions[sessionId];
    if (sess && sess.contextUsed === used && sess.contextMax === max) return;
    set((s) => ({ sessions: updateSession(s.sessions, sessionId, { contextUsed: used, contextMax: max }) }));
  },

  setError: (sessionId, error) => {
    set((s) => ({ sessions: updateSession(s.sessions, sessionId, { error }) }));
  },

  incrementPromptCount: (sessionId) => {
    set((s) => {
      const session = s.sessions[sessionId];
      if (!session) return s;
      return { sessions: updateSession(s.sessions, sessionId, { promptCount: session.promptCount + 1, hasBeenStarted: true }) };
    });
  },

  addTask: (sessionId, task) => {
    set((s) => {
      const session = s.sessions[sessionId];
      if (!session) return s;
      if (session.tasks.some((t) => t.id === task.id)) return s;
      return { sessions: updateSession(s.sessions, sessionId, { tasks: [...session.tasks, task] }) };
    });
  },

  updateTask: (sessionId, taskId, update) => {
    set((s) => {
      const session = s.sessions[sessionId];
      if (!session) return s;
      const tasks = session.tasks.map((t) => t.id === taskId ? { ...t, ...update } : t);
      return { sessions: updateSession(s.sessions, sessionId, { tasks }) };
    });
  },

  setPlanMode: (sessionId, active) => {
    set((s) => ({ sessions: updateSession(s.sessions, sessionId, { planModeActive: active }) }));
  },

  setPendingQuestions: (sessionId, questions) => {
    set((s) => ({ sessions: updateSession(s.sessions, sessionId, { pendingQuestions: questions }) }));
  },

  setPendingPermission: (sessionId, permission) => {
    set((s) => ({ sessions: updateSession(s.sessions, sessionId, { pendingPermission: permission }) }));
  },

  answerQuestion: (sessionId, answer) => {
    set((s) => {
      const session = s.sessions[sessionId];
      if (!session || !session.pendingQuestions) return s;
      const pq = session.pendingQuestions;
      const newAnswers = [...pq.answers, answer];
      const nextIdx = pq.currentIndex + 1;
      if (nextIdx >= pq.items.length) {
        return { sessions: updateSession(s.sessions, sessionId, { pendingQuestions: null }) };
      }
      return {
        sessions: updateSession(s.sessions, sessionId, {
          pendingQuestions: { ...pq, currentIndex: nextIdx, answers: newAnswers },
        }),
      };
    });
  },

  setName: (sessionId, name) => {
    set((s) => {
      const updated = updateSession(s.sessions, sessionId, { name });
      const session = s.sessions[sessionId];
      if (session && !session.ephemeral) saveToStorage(updated);
      return { sessions: updated };
    });
  },

  setCwd: (sessionId, cwd) => {
    const prev = get().sessions[sessionId];
    set((s) => {
      const updated = updateSession(s.sessions, sessionId, { cwd });
      debouncedSave();
      return { sessions: updated };
    });
    // Hydrate from JSONL the first time we learn the cwd for a non-ephemeral
    // session that hasn't been loaded yet.
    if (prev && !prev.ephemeral && !prev.jsonlLoaded && cwd && cwd !== prev.cwd) {
      hydrateFromJsonl(sessionId, cwd);
    }
  },

  setMcpServers: (sessionId, servers) => {
    set((s) => ({ sessions: updateSession(s.sessions, sessionId, { mcpServers: servers }) }));
  },

  setCodexThreadId: (sessionId, threadId) => {
    let shouldHydrate = false;
    let hydrateCwd = "";
    set((s) => {
      const session = s.sessions[sessionId];
      const providerState = resolveSessionProviderState(session);
      const openaiMetadata = getOpenAiProviderSessionMetadata(providerState);
      if (!session || openaiMetadata?.codexThreadId === threadId) return s;
      shouldHydrate = providerState.provider === "openai" && !!threadId && !!session.cwd && session.jsonlLoaded;
      hydrateCwd = session.cwd;
      const updated = updateSession(s.sessions, sessionId, { codexThreadId: threadId });
      if (!session.ephemeral) debouncedSave();
      return { sessions: updated };
    });
    if (shouldHydrate && hydrateCwd) {
      patchSession(sessionId, { jsonlLoaded: false });
      hydrateFromJsonl(sessionId, hydrateCwd);
    }
  },

  setSeedTranscript: (sessionId, messages) => {
    set((s) => {
      const session = s.sessions[sessionId];
      if (!session) return s;
      const next = messages.length > 0 ? messages : null;
      const updated = updateSession(s.sessions, sessionId, { seedTranscript: next });
      if (!session.ephemeral) debouncedSave();
      return { sessions: updated };
    });
  },

  clearSeedTranscript: (sessionId) => {
    set((s) => {
      const session = s.sessions[sessionId];
      if (!session || session.seedTranscript === null) return s;
      const updated = updateSession(s.sessions, sessionId, { seedTranscript: null });
      if (!session.ephemeral) debouncedSave();
      return { sessions: updated };
    });
  },

  setSelectedModel: (sessionId, model) => {
    set((s) => {
      const session = s.sessions[sessionId];
      if (!session || session.selectedModel === model) return s;
      const updated = updateSession(s.sessions, sessionId, { selectedModel: model });
      if (!session.ephemeral) debouncedSave();
      return { sessions: updated };
    });
  },

  setSelectedEffort: (sessionId, effort) => {
    set((s) => {
      const session = s.sessions[sessionId];
      if (!session || session.selectedEffort === effort) return s;
      const updated = updateSession(s.sessions, sessionId, { selectedEffort: effort });
      if (!session.ephemeral) debouncedSave();
      return { sessions: updated };
    });
  },

  setSelectedCodexPermission: (sessionId, permission) => {
    set((s) => {
      const session = s.sessions[sessionId];
      const openaiMetadata = resolveOpenAiProviderSessionMetadata(session);
      if (!session || openaiMetadata?.selectedCodexPermission === permission) return s;
      const updated = updateSession(s.sessions, sessionId, { selectedCodexPermission: permission });
      if (!session.ephemeral) debouncedSave();
      return { sessions: updated };
    });
  },

  enqueuePrompt: (sessionId, prompt) => {
    set((s) => {
      const session = s.sessions[sessionId];
      if (!session) return s;
      const item = createQueuedPrompt(prompt);
      return { sessions: updateSession(s.sessions, sessionId, { promptQueue: [...session.promptQueue, item] }) };
    });
  },

  dequeuePrompt: (sessionId) => {
    let dequeued: QueuedPrompt | undefined;
    set((s) => {
      const session = s.sessions[sessionId];
      if (!session || session.promptQueue.length === 0) return s;
      const [first, ...rest] = session.promptQueue;
      dequeued = first;
      return { sessions: updateSession(s.sessions, sessionId, { promptQueue: rest }) };
    });
    return dequeued;
  },

  removeQueuedPrompt: (sessionId, promptId) => {
    set((s) => {
      const session = s.sessions[sessionId];
      if (!session) return s;
      return { sessions: updateSession(s.sessions, sessionId, { promptQueue: session.promptQueue.filter((p) => p.id !== promptId) }) };
    });
  },

  clearQueue: (sessionId) => {
    set((s) => ({ sessions: updateSession(s.sessions, sessionId, { promptQueue: [] }) }));
  },

  // Hydrate an empty/shorter session from the authoritative JSONL snapshot.
  // Refuses to shrink existing history so a stale load can't clobber a live
  // session that has already accumulated turns.
  loadFromDisk: (sessionId, messages) => {
    set((s) => {
      const session = s.sessions[sessionId];
      if (!session) return s;
      if (session.messages.length >= messages.length) {
        // Still flip the loaded flag — callers rely on it to stop "loading" UI.
        return { sessions: updateSession(s.sessions, sessionId, { jsonlLoaded: true }) };
      }
      const promptCount = messages.filter((m) => m.role === "user").length;
      return { sessions: updateSession(s.sessions, sessionId, {
        messages,
        promptCount,
        hasBeenStarted: promptCount > 0,
        jsonlLoaded: true,
      }) };
    });
  },

  // Explicit refresh treats non-empty provider history as authoritative and
  // may shrink the visible transcript after rewind/truncate. Empty or missing
  // history still preserves live in-memory messages.
  replaceFromDisk: (sessionId, messages) => {
    set((s) => {
      const session = s.sessions[sessionId];
      if (!session) return s;
      if (messages.length === 0) {
        return { sessions: updateSession(s.sessions, sessionId, { jsonlLoaded: true }) };
      }
      const promptCount = messages.filter((m) => m.role === "user").length;
      return { sessions: updateSession(s.sessions, sessionId, {
        messages,
        promptCount,
        hasBeenStarted: promptCount > 0,
        jsonlLoaded: true,
      }) };
    });
  },

  refreshFromHistory: (sessionId, cwd) => hydrateSessionHistory(sessionId, cwd, "replace"),

  mergeFromDisk: (sessionId, incoming) => {
    set((s) => {
      const session = s.sessions[sessionId];
      if (!session) return s;
      if (incoming.length === 0) return s;
      const existingIds = new Set(session.messages.map((m) => m.id));
      const toAppend = incoming.filter((m) => !existingIds.has(m.id));
      if (toAppend.length === 0) return s;
      const merged = [...session.messages, ...toAppend];
      const promptCount = merged.filter((m) => m.role === "user").length;
      return { sessions: updateSession(s.sessions, sessionId, {
        messages: merged,
        promptCount,
        hasBeenStarted: promptCount > 0,
        jsonlLoaded: true,
      }) };
    });
  },

  setDraftPrompt: (sessionId, text) => {
    set((s) => {
      const session = s.sessions[sessionId];
      if (!session || session.draftPrompt === text) return s;
      debouncedSave();
      return { sessions: updateSession(s.sessions, sessionId, { draftPrompt: text }) };
    });
  },

  setLoop: (sessionId, loop) => {
    set((s) => ({ sessions: updateSession(s.sessions, sessionId, { activeLoop: loop }) }));
  },

  tickLoop: (sessionId) => {
    set((s) => {
      const session = s.sessions[sessionId];
      if (!session?.activeLoop) return s;
      return { sessions: updateSession(s.sessions, sessionId, {
        activeLoop: { ...session.activeLoop, lastFiredAt: Date.now(), iteration: session.activeLoop.iteration + 1 },
      }) };
    });
  },

  addModifiedFiles: (sessionId, paths) => {
    set((s) => {
      const session = s.sessions[sessionId];
      if (!session) return s;
      const existing = new Set(session.modifiedFiles);
      const newPaths = paths.filter((p) => !existing.has(p));
      if (newPaths.length === 0) return s;
      return { sessions: updateSession(s.sessions, sessionId, { modifiedFiles: [...session.modifiedFiles, ...newPaths] }) };
    });
  },

  resetModifiedFiles: (sessionId) => {
    set((s) => ({ sessions: updateSession(s.sessions, sessionId, { modifiedFiles: [] }) }));
  },

  deleteSession: (sessionId) => {
    hydrationCache.delete(sessionId);
    set((s) => {
      const { [sessionId]: _, ...rest } = s.sessions;
      try {
        deletePersistedMeta(sessionId);
      } catch (e) {
        console.warn("[claudeStore] Failed to delete metadata:", e);
      }
      return { sessions: rest };
    });
  },

  setAutoCompactStatus: (sessionId, status) => {
    set((s) => ({ sessions: updateSession(s.sessions, sessionId, {
      autoCompactStatus: status,
      autoCompactStartedAt: status === "compacting" ? Date.now() : s.sessions[sessionId]?.autoCompactStartedAt ?? null,
    }) }));
  },

  setResumeAtUuid: (sessionId, uuid) => {
    set((s) => ({ sessions: updateSession(s.sessions, sessionId, { resumeAtUuid: uuid }) }));
  },

  setForkParentSessionId: (sessionId, parentId) => {
    set((s) => ({ sessions: updateSession(s.sessions, sessionId, { forkParentSessionId: parentId }) }));
  },

  truncateFromMessage: (sessionId, messageId) => {
    hydrationCache.delete(sessionId);
    set((s) => {
      const session = s.sessions[sessionId];
      if (!session) return s;
      const idx = session.messages.findIndex((m) => m.id === messageId);
      if (idx < 0) return s;
      const messages = session.messages.slice(0, idx);
      const promptCount = messages.filter((m) => m.role === "user").length;
      return { sessions: updateSession(s.sessions, sessionId, {
        messages, promptCount, streamingText: "", isStreaming: false, error: null,
        pendingPermission: null, pendingQuestions: null, activeLoop: null, promptQueue: [],
      }) };
    });
  },

  addHookEvent: (sessionId, event) => {
    set((s) => {
      const session = s.sessions[sessionId];
      if (!session) return s;
      const log = session.hookEventLog.length >= 500
        ? [...session.hookEventLog.slice(-499), event]
        : [...session.hookEventLog, event];
      return { sessions: updateSession(s.sessions, sessionId, { hookEventLog: log }) };
    });
  },

  recordToolUsage: (sessionId, toolName) => {
    set((s) => {
      const session = s.sessions[sessionId];
      if (!session) return s;
      const stats = { ...session.toolUsageStats };
      stats[toolName] = (stats[toolName] || 0) + 1;
      return { sessions: updateSession(s.sessions, sessionId, { toolUsageStats: stats }) };
    });
  },

  incrementCompactionCount: (sessionId) => {
    set((s) => {
      const session = s.sessions[sessionId];
      if (!session) return s;
      return { sessions: updateSession(s.sessions, sessionId, { compactionCount: session.compactionCount + 1 }) };
    });
  },

  addSubagent: (sessionId, subagentId) => {
    set((s) => {
      const session = s.sessions[sessionId];
      if (!session || session.subagentIds.includes(subagentId)) return s;
      return { sessions: updateSession(s.sessions, sessionId, { subagentIds: [...session.subagentIds, subagentId] }) };
    });
  },

  removeSubagent: (sessionId, subagentId) => {
    set((s) => {
      const session = s.sessions[sessionId];
      if (!session) return s;
      const filtered = session.subagentIds.filter((id) => id !== subagentId);
      if (filtered.length === session.subagentIds.length) return s;
      return { sessions: updateSession(s.sessions, sessionId, { subagentIds: filtered }) };
    });
  },
}));

export const useProviderSessionStore = providerSessionStore;
/** @deprecated Use useProviderSessionStore. */
export const useClaudeStore = useProviderSessionStore;

// Provider routing selector. Returns "anthropic" for any unknown / missing
// session so the legacy Claude path stays the safe default.
export function selectSessionProvider(sessionId: string): ProviderId {
  const session = useClaudeStore.getState().sessions[sessionId];
  return resolveSessionProviderState(session).provider;
}

export function selectSessionProviderState(sessionId: string): ProviderSessionState {
  const session = useClaudeStore.getState().sessions[sessionId];
  return resolveSessionProviderState(session);
}

export function selectSessionProviderMetadata<P extends ProviderId>(
  sessionId: string,
  provider: P,
): ProviderSessionMetadataFor<P> | undefined {
  return getProviderSessionMetadata(selectSessionProviderState(sessionId), provider);
}

// Lightweight selector for voice/fuzzy session matching.
export function getSessionsForVoiceMatch(): { id: string; name: string }[] {
  const sessions = useClaudeStore.getState().sessions;
  const out: { id: string; name: string }[] = [];
  for (const s of Object.values(sessions)) {
    if (s.name && s.name.trim()) out.push({ id: s.sessionId, name: s.name });
  }
  return out;
}

// Emergency metadata flush on tab hide / close. Cheap now that the payload is
// just a handful of strings per session.
export function flushSave() {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  if (idleSaveHandle !== null) {
    cancelIdle(idleSaveHandle);
    idleSaveHandle = null;
  }
  savePending = false;
  saveToStorage(useClaudeStore.getState().sessions);
}

const visibilityHandler = () => { if (document.visibilityState === "hidden") flushSave(); };
if (typeof window !== "undefined") {
  document.addEventListener("visibilitychange", visibilityHandler);
  window.addEventListener("beforeunload", flushSave);

  if (import.meta.hot) {
    import.meta.hot.dispose(() => {
      document.removeEventListener("visibilitychange", visibilityHandler);
      window.removeEventListener("beforeunload", flushSave);
      if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
      if (idleSaveHandle !== null) {
        cancelIdle(idleSaveHandle);
        idleSaveHandle = null;
      }
    });
  }
}
