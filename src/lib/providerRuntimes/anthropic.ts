import {
  ensureT64Mcp,
  mapHistoryMessages,
  providerCancel,
  providerClose,
  providerCreate,
  providerHistoryDelete,
  providerHistoryFork,
  providerHistoryHydrate,
  providerHistoryTruncate,
  providerSend,
} from "../tauriApi";
import type {
  ProviderHistoryTruncateResult,
  ProviderHistoryDeleteResult,
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
    const result = await providerHistoryTruncate({
      provider: "anthropic",
      req: {
        session_id: input.sessionId,
        cwd: input.cwd,
        keep_messages: input.keepMessages,
      },
    });
    return { resumeAtUuid: result.resume_at_uuid ?? null };
  },

  async fork(input) {
    if (input.keepMessages > 0) {
      await providerHistoryFork({
        provider: "anthropic",
        req: {
          parent_session_id: input.parentSessionId,
          new_session_id: input.newSessionId,
          cwd: input.cwd,
          keep_messages: input.keepMessages,
        },
      });
    }
    return {};
  },

  async hydrate(input): Promise<ProviderHydrateResult> {
    const result = await providerHistoryHydrate({
      provider: "anthropic",
      req: { session_id: input.sessionId, cwd: input.cwd },
    });
    const stat = result.stat;
    if (!stat) {
      return { status: "empty", clearCache: true };
    }

    const cached = input.cacheEntry;
    if (cached && cached.mtimeMs === stat.mtime_ms && cached.size === stat.size) {
      return { status: "messages", messages: cached.messages };
    }

    const history = result.messages;
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

  async deleteHistory(input): Promise<ProviderHistoryDeleteResult> {
    await providerHistoryDelete({
      provider: "anthropic",
      req: {
        session_id: input.sessionId,
        cwd: input.cwd,
      },
    });
    return { method: "deleted" };
  },
};
