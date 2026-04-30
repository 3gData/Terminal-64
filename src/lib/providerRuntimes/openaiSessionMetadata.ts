import {
  resolveOpenAiProviderSessionMetadata,
  useProviderSessionStore,
} from "../../stores/providerSessionStore";

export function getOpenAiThreadIdForSession(sessionId: string): string | null {
  const session = useProviderSessionStore.getState().sessions[sessionId];
  return resolveOpenAiProviderSessionMetadata(session)?.codexThreadId ?? session?.codexThreadId ?? null;
}

export function setOpenAiThreadIdForSession(sessionId: string, threadId: string | null): void {
  useProviderSessionStore.getState().setCodexThreadId(sessionId, threadId);
}
