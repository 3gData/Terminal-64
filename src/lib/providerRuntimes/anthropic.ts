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
  ProviderHistoryDeleteResult,
  ProviderHistoryTruncateResult,
  ProviderHydrateResult,
  ProviderRuntime,
  ProviderTurnInput,
  ProviderTurnResult,
} from "../../contracts/providerRuntime";
import type { CreateClaudeRequest, SendClaudePromptRequest } from "../types";

declare module "../../contracts/providerIpc" {
  interface ProviderCreateRequestMap {
    anthropic: CreateClaudeRequest;
  }

  interface ProviderSendRequestMap {
    anthropic: SendClaudePromptRequest;
  }

  interface ProviderHistoryTruncateRequestMap {
    anthropic: {
      session_id: string;
      cwd: string;
      keep_messages: number;
    };
  }

  interface ProviderHistoryForkRequestMap {
    anthropic: {
      parent_session_id: string;
      new_session_id: string;
      cwd: string;
      keep_messages: number;
    };
  }

  interface ProviderHistoryHydrateRequestMap {
    anthropic: {
      session_id: string;
      cwd: string;
      resume_at_uuid?: string | null;
    };
  }

  interface ProviderHistoryDeleteRequestMap {
    anthropic: {
      session_id: string;
      cwd: string;
    };
  }
}

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
    ...(input.resumeAtUuid ? { resume_session_at: input.resumeAtUuid } : {}),
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

function operationStatus(status: "applied" | "skipped" | "unsupported" | undefined) {
  return status ?? "applied";
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

  history: {
    capabilities: {
      hydrate: true,
      fork: true,
      rewind: true,
      delete: true,
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
      const output: ProviderHistoryTruncateResult = {
        status: operationStatus(result.status),
        resumeAtUuid: result.resume_at_uuid ?? null,
      };
      if (result.reason) output.reason = result.reason;
      return output;
    },

    async fork(input) {
      if (input.keepMessages <= 0) {
        return { status: "skipped", reason: "no_messages_to_fork" };
      }
      const result = await providerHistoryFork({
        provider: "anthropic",
        req: {
          parent_session_id: input.parentSessionId,
          new_session_id: input.newSessionId,
          cwd: input.cwd,
          keep_messages: input.keepMessages,
        },
      });
      const output = { status: operationStatus(result.status) };
      if (result.reason) return { ...output, reason: result.reason };
      return output;
    },

    async hydrate(input): Promise<ProviderHydrateResult> {
      const result = await providerHistoryHydrate({
        provider: "anthropic",
        req: {
          session_id: input.sessionId,
          cwd: input.cwd,
          ...(input.resumeAtUuid ? { resume_at_uuid: input.resumeAtUuid } : {}),
        },
      });
      if (result.status === "skipped" || result.status === "unsupported") {
        return {
          status: result.status,
          ...(result.reason ? { reason: result.reason } : {}),
          clearCache: true,
        };
      }
      const stat = result.stat;
      if (!stat) {
        return { status: "empty", clearCache: true };
      }

      const cached = input.resumeAtUuid ? null : input.cacheEntry;
      if (cached && cached.mtimeMs === stat.mtime_ms && cached.size === stat.size) {
        return { status: "messages", messages: cached.messages };
      }

      const history = result.messages;
      if (history.length === 0) {
        return { status: "empty" };
      }

      const messages = mapHistoryMessages(history);
      if (input.resumeAtUuid) {
        return { status: "messages", messages, clearCache: true };
      }
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
      const result = await providerHistoryDelete({
        provider: "anthropic",
        req: {
          session_id: input.sessionId,
          cwd: input.cwd,
        },
      });
      const output: ProviderHistoryDeleteResult = {
        status: operationStatus(result.status),
        method: result.method,
      };
      if (result.reason) output.reason = result.reason;
      return output;
    },
  },
};
