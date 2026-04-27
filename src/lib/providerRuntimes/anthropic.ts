import {
  ensureT64Mcp,
  forkSessionJsonl,
  loadSessionHistory,
  mapHistoryMessages,
  providerCancel,
  providerClose,
  providerCreate,
  providerSend,
  truncateSessionJsonlByMessages,
  statSessionJsonl,
} from "../tauriApi";
import type {
  ProviderHistoryTruncateResult,
  ProviderHydrateResult,
  ProviderRuntime,
  ProviderTurnInput,
  ProviderTurnResult,
} from "../../contracts/providerRuntime";
import type { CreateClaudeRequest, SendClaudePromptRequest } from "../types";

function buildClaudeRequest(input: ProviderTurnInput): CreateClaudeRequest {
  return {
    session_id: input.sessionId,
    cwd: input.cwd,
    prompt: input.prompt,
    permission_mode: input.permissionOverride || input.permissionMode || "default",
    ...(input.selectedModel ? { model: input.selectedModel } : {}),
    ...(input.selectedEffort ? { effort: input.selectedEffort } : {}),
    ...(input.mcpConfig ? { mcp_config: input.mcpConfig } : {}),
    ...(input.noSessionPersistence ? { no_session_persistence: true } : {}),
  };
}

function buildClaudeSendRequest(input: ProviderTurnInput): SendClaudePromptRequest {
  return {
    ...buildClaudeRequest(input),
    ...(input.disallowedTools ? { disallowed_tools: input.disallowedTools } : {}),
  };
}

async function ensureFirstTurnMcp(input: ProviderTurnInput) {
  if (!input.started) {
    await ensureT64Mcp(input.cwd).catch(() => {});
  }
}

function legacyResumeResult(input: ProviderTurnInput): ProviderTurnResult {
  return input.resumeAtUuid ? { clearResumeAtUuid: true } : {};
}

async function create(input: ProviderTurnInput): Promise<ProviderTurnResult> {
  await ensureFirstTurnMcp(input);
  const req = buildClaudeRequest(input);
  try {
    await providerCreate({ provider: "anthropic", req }, input.skipOpenwolf);
  } catch {
    await providerSend({ provider: "anthropic", req }, input.skipOpenwolf);
  }
  return legacyResumeResult(input);
}

async function send(input: ProviderTurnInput): Promise<ProviderTurnResult> {
  await ensureFirstTurnMcp(input);
  const req = buildClaudeSendRequest(input);
  if (input.forkParentSessionId) {
    const forkReq: SendClaudePromptRequest = { ...req, fork_session: input.forkParentSessionId };
    await providerSend({ provider: "anthropic", req: forkReq }, input.skipOpenwolf);
    return {
      clearForkParentSessionId: true,
      ...(input.resumeAtUuid ? { clearResumeAtUuid: true } : {}),
    };
  }
  try {
    await providerSend({ provider: "anthropic", req }, input.skipOpenwolf);
  } catch {
    await providerCreate({ provider: "anthropic", req }, input.skipOpenwolf);
  }
  return legacyResumeResult(input);
}

export const anthropicRuntime: ProviderRuntime = {
  provider: "anthropic",

  create,

  send,

  cancel(sessionId) {
    return providerCancel("anthropic", sessionId);
  },

  close(sessionId) {
    return providerClose("anthropic", sessionId);
  },

  async rewind(input): Promise<ProviderHistoryTruncateResult> {
    await truncateSessionJsonlByMessages(input.sessionId, input.cwd, input.keepMessages);
    return { resumeAtUuid: null };
  },

  async fork(input) {
    if (input.keepMessages > 0) {
      await forkSessionJsonl(input.parentSessionId, input.newSessionId, input.cwd, input.keepMessages);
    }
    return {};
  },

  async hydrate(input): Promise<ProviderHydrateResult> {
    const stat = await statSessionJsonl(input.sessionId, input.cwd);
    if (!stat) {
      return { status: "empty", clearCache: true };
    }

    const cached = input.cacheEntry;
    if (cached && cached.mtimeMs === stat.mtime_ms && cached.size === stat.size) {
      return { status: "messages", messages: cached.messages };
    }

    const history = await loadSessionHistory(input.sessionId, input.cwd);
    if (history.length === 0) {
      return { status: "empty" };
    }

    const messages = mapHistoryMessages(history);
    return {
      status: "messages",
      messages,
      cacheWrite: {
        mtimeMs: stat.mtime_ms,
        size: stat.size,
        messages,
      },
    };
  },
};
