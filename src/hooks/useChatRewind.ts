import { useCallback } from "react";
import { providerHistorySupports, truncateProviderHistory } from "../lib/providerRuntime";
import { useProviderSessionStore } from "../stores/providerSessionStore";
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
    const session = useProviderSessionStore.getState().sessions[sessionId];
    const input: ProviderHistoryTruncateInput = {
      provider,
      sessionId,
      cwd,
      keepMessages,
      preMessages: session?.messages ?? [],
    };
    const result = await truncateProviderHistory(input);
    if (result.status === "unsupported") {
      throw new Error(result.reason ?? `Provider ${provider} does not support history rewind`);
    }
    useProviderSessionStore.getState().setResumeAtUuid(sessionId, result.resumeAtUuid ?? null);
  }, []);
}
