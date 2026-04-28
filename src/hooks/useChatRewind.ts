import { useCallback } from "react";
import { providerHistorySupports, truncateProviderHistory } from "../lib/providerRuntime";
import { getOpenAiProviderSessionMetadata, resolveSessionProviderState, useClaudeStore } from "../stores/claudeStore";
import type { ProviderId } from "../lib/providers";
import type { ProviderHistoryTruncateInput } from "../contracts/providerRuntime";

interface RewindHistoryInput {
  provider: ProviderId;
  sessionId: string;
  cwd: string;
  keepMessages: number;
}

export function useChatRewind() {
  return useCallback(async ({
    provider,
    sessionId,
    cwd,
    keepMessages,
  }: RewindHistoryInput) => {
    if (!providerHistorySupports(provider, "rewind")) {
      throw new Error(`Provider ${provider} does not support history rewind`);
    }
    const session = useClaudeStore.getState().sessions[sessionId];
    const providerState = resolveSessionProviderState(session);
    const codexThreadId = getOpenAiProviderSessionMetadata(providerState)?.codexThreadId ?? null;
    const input: ProviderHistoryTruncateInput = {
      provider,
      sessionId,
      cwd,
      keepMessages,
      preMessages: session?.messages ?? [],
    };
    if (codexThreadId !== undefined) {
      input.codexThreadId = codexThreadId;
    }
    const result = await truncateProviderHistory(input);
    if (result.status === "unsupported") {
      throw new Error(result.reason ?? `Provider ${provider} does not support history rewind`);
    }
    useClaudeStore.getState().setResumeAtUuid(sessionId, result.resumeAtUuid ?? null);
  }, []);
}
