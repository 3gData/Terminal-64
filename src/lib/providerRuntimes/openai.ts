import {
  ensureCodexMcp,
  ensureCodexSkills,
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
import type { PermissionMode, ChatMessage } from "../types";
import type { CreateCodexRequest, SendCodexPromptRequest } from "../../contracts/providerIpc";
import type {
  ProviderHistoryTruncateResult,
  ProviderHistoryDeleteResult,
  ProviderHydrateResult,
  ProviderRuntime,
  ProviderTurnInput,
  ProviderTurnResult,
} from "../../contracts/providerRuntime";
import { decodeCodexPermission } from "../providers";

export function codexPermissionForOverride(current: string, override?: PermissionMode) {
  if (override === "bypass_all") return decodeCodexPermission("yolo");
  if (override === "accept_edits" || override === "auto") return decodeCodexPermission("full-auto");
  if (override === "plan") return decodeCodexPermission("read-only");
  return decodeCodexPermission(current);
}

function renderSeedTranscript(messages: ChatMessage[]): string {
  return messages.map((m) => {
    const who = m.role === "user" ? "User" : "Assistant";
    const text = (m.content || "").trim();
    const tools = m.toolCalls?.length
      ? "\n" + m.toolCalls.map((tc) => {
        const args = Object.keys(tc.input || {}).length ? ` ${JSON.stringify(tc.input)}` : "";
        return `Tool: ${tc.name}${args}`;
      }).join("\n")
      : "";
    return `${who}: ${text}${tools}`.trim();
  }).join("\n\n");
}

export function promptWithCodexSeed(prompt: string, seedTranscript: ChatMessage[] | null | undefined): string {
  if (!seedTranscript?.length) return prompt;
  return `You are continuing from a forked Terminal 64 conversation. Prior transcript:\n\n${renderSeedTranscript(seedTranscript)}\n\nContinue from there and answer this new user message:\n\n${prompt}`;
}

async function ensureCodexRuntime(input: ProviderTurnInput) {
  await Promise.allSettled([ensureCodexMcp(input.cwd), ensureCodexSkills()]);
}

export function buildCodexCreateRequest(input: ProviderTurnInput): CreateCodexRequest {
  const prompt = promptWithCodexSeed(input.prompt, input.seedTranscript);
  const codexPerm = codexPermissionForOverride(
    input.selectedCodexPermission || "workspace",
    input.permissionOverride,
  );
  return {
    session_id: input.sessionId,
    cwd: input.cwd,
    prompt,
    ...(input.selectedModel ? { model: input.selectedModel } : {}),
    ...(input.selectedEffort ? { effort: input.selectedEffort } : {}),
    ...(input.codexCollaborationMode ? { collaboration_mode: input.codexCollaborationMode } : {}),
    ...(input.skipGitRepoCheck ? { skip_git_repo_check: true } : {}),
    ...(input.mcpEnv ? { mcp_env: input.mcpEnv } : {}),
    ...codexPerm,
  };
}

export function buildCodexSendRequest(input: ProviderTurnInput, createReq: CreateCodexRequest): SendCodexPromptRequest {
  return {
    ...createReq,
    ...(input.threadId ? { thread_id: input.threadId } : {}),
  };
}

export function codexDropTurnsForKeepMessages(preMessages: ChatMessage[], keepMessages: number): number {
  const totalTurns = preMessages.filter((m) => m.role === "user").length;
  const keepTurns = preMessages.slice(0, keepMessages).filter((m) => m.role === "user").length;
  return Math.max(0, totalTurns - keepTurns);
}

function seedResult(input: ProviderTurnInput): ProviderTurnResult {
  return { clearSeedTranscript: !!input.seedTranscript?.length };
}

async function create(input: ProviderTurnInput): Promise<ProviderTurnResult> {
  await ensureCodexRuntime(input);
  const createReq = buildCodexCreateRequest(input);
  const sendReq = buildCodexSendRequest(input, createReq);
  try {
    await providerCreate({ provider: "openai", req: createReq }, input.skipOpenwolf);
  } catch {
    if (!input.started) {
      throw new Error("Codex session failed to start before a thread id was created.");
    }
    // Legacy metadata from early Codex builds did not persist the external
    // thread id. Only already-started sessions get the old local-id resume
    // fallback; a true first turn would otherwise resume the wrong id.
    await providerSend({ provider: "openai", req: sendReq }, input.skipOpenwolf);
  }
  return seedResult(input);
}

async function send(input: ProviderTurnInput): Promise<ProviderTurnResult> {
  await ensureCodexRuntime(input);
  const createReq = buildCodexCreateRequest(input);
  const sendReq = buildCodexSendRequest(input, createReq);
  if (!input.threadId) {
    try {
      await providerCreate({ provider: "openai", req: createReq }, input.skipOpenwolf);
    } catch {
      if (!input.started) {
        throw new Error("Codex session failed to start before a thread id was created.");
      }
      await providerSend({ provider: "openai", req: sendReq }, input.skipOpenwolf);
    }
    return seedResult(input);
  }
  try {
    await providerSend({ provider: "openai", req: sendReq }, input.skipOpenwolf);
  } catch {
    await providerCreate({ provider: "openai", req: createReq }, input.skipOpenwolf);
  }
  return seedResult(input);
}

export const openaiRuntime: ProviderRuntime = {
  provider: "openai",

  create,

  send,

  cancel(sessionId) {
    return providerCancel("openai", sessionId);
  },

  close(sessionId) {
    return providerClose("openai", sessionId);
  },

  async rewind(input): Promise<ProviderHistoryTruncateResult> {
    if (input.codexThreadId) {
      const dropTurns = codexDropTurnsForKeepMessages(input.preMessages, input.keepMessages);
      const result = await providerHistoryTruncate({
        provider: "openai",
        req: {
          thread_id: input.codexThreadId,
          cwd: input.cwd,
          num_turns: dropTurns,
        },
      });
      if (result.method === "rollout" && result.rollback_error) {
        console.warn("[providerRuntime] Codex app-server rollback failed, fell back to rollout truncation:", result.rollback_error);
      }
    }
    return {};
  },

  async fork(input) {
    if (input.keepMessages <= 0) return {};
    if (!input.codexThreadId) return { seedTranscript: true };

    const dropTurns = codexDropTurnsForKeepMessages(input.preMessages, input.keepMessages);
    try {
      const result = await providerHistoryFork({
        provider: "openai",
        req: {
          thread_id: input.codexThreadId,
          cwd: input.cwd,
          drop_turns: dropTurns,
        },
      });
      if (!result.codex_thread_id) {
        throw new Error("OpenAI history fork did not return a thread id");
      }
      return {
        codexThreadId: result.codex_thread_id,
      };
    } catch (err) {
      console.warn("[fork] Codex app-server fork failed; falling back to seeded transcript:", err);
      return { seedTranscript: true };
    }
  },

  async hydrate(input): Promise<ProviderHydrateResult> {
    if (!input.codexThreadId) {
      return { status: "empty" };
    }
    const result = await providerHistoryHydrate({
      provider: "openai",
      req: { thread_id: input.codexThreadId },
    });
    const history = result.messages;
    if (history.length === 0) {
      return { status: "empty" };
    }
    return { status: "messages", messages: mapHistoryMessages(history) };
  },

  async deleteHistory(input): Promise<ProviderHistoryDeleteResult> {
    const result = await providerHistoryDelete({
      provider: "openai",
      req: input.codexThreadId ? { thread_id: input.codexThreadId } : {},
    });
    return result;
  },
};
