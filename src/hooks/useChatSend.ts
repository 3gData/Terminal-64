import { useCallback } from "react";
import { createCheckpoint, readFile } from "../lib/tauriApi";
import { runProviderTurn } from "../lib/providerRuntime";
import { isAbsolutePath, joinPath } from "../lib/platform";
import {
  getProviderSessionRuntimeMetadata,
  resolveSessionProviderState,
  useProviderSessionStore,
  type ProviderControlValueMap,
} from "../stores/providerSessionStore";
import type { PermissionMode } from "../lib/types";
import type { ProviderTurnInput } from "../contracts/providerRuntime";

interface UseChatSendOptions {
  sessionId: string;
  effectiveCwd: string;
  permissionMode: PermissionMode;
  selectedControls: ProviderControlValueMap;
  selectedProviderPermissionId: string;
  incrementPromptCount: (sessionId: string) => void;
}

export function useChatSend({
  sessionId,
  effectiveCwd,
  permissionMode,
  selectedControls,
  selectedProviderPermissionId,
  incrementPromptCount,
}: UseChatSendOptions) {
  return useCallback(
    async (
      prompt: string,
      permissionOverride?: PermissionMode,
      opts?: { codexCollaborationMode?: "plan" | "default" },
    ) => {
      const store = useProviderSessionStore.getState();
      const sess = store.sessions[sessionId];
      const started = (sess?.hasBeenStarted ?? false) && (sess?.promptCount ?? 0) > 0;
      const providerState = resolveSessionProviderState(sess);
      const provider = providerState.provider;
      const seedTranscript = providerState.seedTranscript;
      try {
        if (!started && (!effectiveCwd || effectiveCwd === ".")) {
          store.setError(sessionId, "No working directory set. Create a new session.");
          return;
        }
        store.setStreaming(sessionId, true);
        if (sess && sess.modifiedFiles.length > 0) {
          const snapshotBase = sess.cwd || effectiveCwd;
          const resolveSnapshotPath = (fp: string) =>
            fp && !isAbsolutePath(fp) && snapshotBase ? joinPath(snapshotBase, fp) : fp;
          const results = await Promise.allSettled(
            sess.modifiedFiles.map(async (fp) => {
              const path = resolveSnapshotPath(fp);
              try { return { path, content: await readFile(path) }; }
              catch { return { path, content: "" }; }
            }),
          );
          const snapshots = results.map((r) => (r as PromiseFulfilledResult<{ path: string; content: string }>).value);
          createCheckpoint(sessionId, sess.promptCount + 1, snapshots).catch(() => {});
        }
        if (effectiveCwd && effectiveCwd !== "." && (!sess?.cwd || sess.cwd !== effectiveCwd)) {
          store.setCwd(sessionId, effectiveCwd);
        }

        let providerPrompt = prompt;
        let codexCollaborationMode = opts?.codexCollaborationMode;
        if (provider === "openai" && !codexCollaborationMode) {
          const codexPlanMatch = prompt.match(/^\/plan(?:\s+([\s\S]*))?$/i);
          if (codexPlanMatch) {
            codexCollaborationMode = "plan";
            providerPrompt = codexPlanMatch[1]?.trim() || "Create a plan.";
          }
        }

        const turnInput: ProviderTurnInput = {
          provider,
          sessionId,
          cwd: effectiveCwd,
          prompt: providerPrompt,
          started,
          runtimeMetadata: getProviderSessionRuntimeMetadata(providerState, provider),
          selectedControls,
          providerPermissionId: selectedProviderPermissionId,
          permissionMode,
          skipOpenwolf: sess?.skipOpenwolf || false,
          seedTranscript,
          resumeAtUuid: sess?.resumeAtUuid ?? null,
          forkParentSessionId: sess?.forkParentSessionId ?? null,
          ...(provider === "openai" && codexCollaborationMode !== undefined
            ? { providerOptions: { openai: { collaborationMode: codexCollaborationMode } } }
            : {}),
        };
        if (permissionOverride !== undefined) {
          turnInput.permissionOverride = permissionOverride;
        }

        const result = await runProviderTurn(turnInput);

        if (result.clearSeedTranscript) store.clearSeedTranscript(sessionId);
        if (result.clearResumeAtUuid) store.setResumeAtUuid(sessionId, null);
        if (result.clearForkParentSessionId) store.setForkParentSessionId(sessionId, null);
        incrementPromptCount(sessionId);
      } catch (err) {
        const currentStore = useProviderSessionStore.getState();
        currentStore.setStreaming(sessionId, false);
        currentStore.setError(sessionId, String(err));
      }
    },
    [sessionId, effectiveCwd, permissionMode, selectedControls, selectedProviderPermissionId, incrementPromptCount],
  );
}
