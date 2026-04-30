import { useCallback } from "react";
import { useCanvasStore } from "../stores/canvasStore";
import {
  getProviderPermissionId,
  resolveSessionProviderState,
  useProviderSessionStore,
} from "../stores/providerSessionStore";
import { prepareProviderFork, providerHistorySupports } from "../lib/providerRuntime";
import type { ProviderForkInput, ProviderForkResult } from "../contracts/providerRuntime";

interface UseChatForkOptions {
  sessionId: string;
  effectiveCwd: string;
}

export function useChatFork({ sessionId, effectiveCwd }: UseChatForkOptions) {
  return useCallback(async (messageId: string) => {
    const store = useProviderSessionStore.getState();
    const sess = store.sessions[sessionId];
    if (!sess) return;
    const providerState = resolveSessionProviderState(sess);
    const provider = providerState.provider;

    if (!providerHistorySupports(provider, "fork")) {
      console.warn("[fork] provider does not support history fork:", provider);
      return;
    }

    const msgIdx = sess.messages.findIndex((m) => m.id === messageId);
    if (msgIdx < 0) return;
    const forkedMessages = sess.messages.slice(0, msgIdx);

    const canvas = useCanvasStore.getState();
    const parentPanel = canvas.terminals.find((t) => t.terminalId === sessionId);
    const x = parentPanel?.x ?? 80;
    const y = (parentPanel?.y ?? 80) - (parentPanel?.height ?? 400) - 20;
    const w = parentPanel?.width;
    const h = parentPanel?.height;

    const newPanel = canvas.addClaudeTerminalAt(
      effectiveCwd, false, undefined, undefined, x, y, w, h,
    );

    // Seed the child store row before any async fork work. The new panel mounts
    // immediately after addClaudeTerminalAt; if ProviderChat wins that race it will
    // create the session with the default Anthropic provider.
    store.createSession(newPanel.terminalId, undefined, false, undefined, effectiveCwd, provider, true);
    for (const [controlId, value] of Object.entries(providerState.selectedControls[provider] ?? {})) {
      store.setProviderControl(newPanel.terminalId, provider, controlId, value);
    }
    store.setSelectedModel(newPanel.terminalId, providerState.selectedModel);
    store.setSelectedEffort(newPanel.terminalId, providerState.selectedEffort);
    store.setProviderPermission(newPanel.terminalId, provider, getProviderPermissionId(providerState, provider));

    let forkResult: ProviderForkResult = {};
    if (forkedMessages.length > 0) {
      const forkInput: ProviderForkInput = {
        provider,
        parentSessionId: sessionId,
        newSessionId: newPanel.terminalId,
        cwd: effectiveCwd,
        keepMessages: msgIdx,
        preMessages: sess.messages,
      };
      try {
        forkResult = await prepareProviderFork(forkInput);
      } catch (err) {
        console.warn("[fork] provider fork preparation failed; falling back to first-turn fork handling:", err);
        if (provider === "openai") {
          forkResult = { seedTranscript: true };
        }
      }
      if (forkResult.status === "unsupported") {
        console.warn("[fork] provider history fork returned unsupported:", forkResult.reason ?? provider);
        return;
      }
    }

    if (forkedMessages.length > 0) {
      store.loadFromDisk(newPanel.terminalId, forkedMessages);
      if (provider === "openai" && forkResult.seedTranscript) {
        store.setSeedTranscript(newPanel.terminalId, forkedMessages);
      }
    }
  }, [sessionId, effectiveCwd]);
}
