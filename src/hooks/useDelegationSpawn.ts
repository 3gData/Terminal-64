import { useCallback } from "react";
import { v4 as uuidv4 } from "uuid";
import { getDelegationPort, getDelegationSecret } from "../lib/tauriApi";
import type { PermissionMode } from "../lib/types";
import type { ProviderId } from "../lib/providers";
import { runProviderTurn } from "../lib/providerRuntime";
import {
  buildDelegationChildRuntimeMetadata,
  prepareDelegationChildProviderTurnInput,
  resolveDelegationChildRuntimeSettings,
} from "../lib/delegationChildRuntime";
import { useCanvasStore } from "../stores/canvasStore";
import { useClaudeStore } from "../stores/claudeStore";
import { useDelegationStore } from "../stores/delegationStore";

interface UseDelegationSpawnOptions {
  sessionId: string;
  effectiveCwd: string;
  selectedProvider: ProviderId;
  permissionMode: PermissionMode;
  selectedModel: string;
  selectedEffort: string;
  selectedCodexPermission: string;
  addUserMessage: (sessionId: string, text: string) => void;
}

export function useDelegationSpawn({
  sessionId,
  effectiveCwd,
  selectedProvider,
  permissionMode,
  selectedModel,
  selectedEffort,
  selectedCodexPermission,
  addUserMessage,
}: UseDelegationSpawnOptions) {
  return useCallback(
    async (tasks: { description: string }[], sharedContext: string) => {
      const delStore = useDelegationStore.getState();
      const group = delStore.createGroup(sessionId, tasks, "auto", sharedContext || undefined, permissionMode);

      const canvas = useCanvasStore.getState();
      const parentPanel = canvas.terminals.find((t) => t.terminalId === sessionId);
      const parentW = parentPanel?.width || 600;
      const parentH = parentPanel?.height || 400;
      canvas.addSharedChatPanel(
        group.id,
        parentPanel?.x || 80,
        (parentPanel?.y || 80) + parentH + 20,
        parentW,
        Math.min(300, parentH * 0.6),
      );

      let delegationPort = 0;
      let delegationSecret = "";
      try {
        delegationPort = await getDelegationPort();
        delegationSecret = await getDelegationSecret();
      } catch (err) {
        console.warn("[delegation] Failed to get port/secret:", err);
      }

      const parentSess = useClaudeStore.getState().sessions[sessionId];
      const sessCwd = parentSess?.cwd;
      const appDir = (effectiveCwd && effectiveCwd !== "." && effectiveCwd !== "/")
        ? effectiveCwd
        : (sessCwd && sessCwd !== "." && sessCwd !== "/")
          ? sessCwd
          : "";
      const childRuntime = resolveDelegationChildRuntimeSettings({
        parentSession: parentSess,
        selectedProvider,
        selectedModel,
        selectedEffort,
        selectedCodexPermission,
      });

      group.tasks.forEach((task, i) => {
        const childSessionId = uuidv4();
        const childName = `[D] ${task.description.slice(0, 30)}`;
        const agentLabel = `Agent ${i + 1}`;

        delStore.setTaskSessionId(
          group.id,
          task.id,
          childSessionId,
          buildDelegationChildRuntimeMetadata(childRuntime, appDir),
        );
        delStore.updateTaskStatus(group.id, task.id, "running");

        const channelNote = delegationPort > 0
          ? `\n\nIMPORTANT — Team Coordination via terminal-64 MCP:
You are part of a team of ${tasks.length} agents working in the same codebase. You MUST use the team chat to coordinate:

1. send_to_team — Post a message to the shared team chat. Do this:
   • At the START of your work (announce what you're about to do)
   • Before modifying any shared files (to avoid conflicts)
   • After completing major milestones
   • If you encounter issues or blockers
2. read_team — Check what other agents have posted. Do this BEFORE starting work and periodically during long tasks to stay aware of what others are doing.
3. report_done — When your task is fully complete, call this with a summary of what you did and what files you changed.

Coordinate actively. If another agent is working on a file you need, mention it in team chat and work around it. Communication prevents conflicts.`
          : "";

        const initialPrompt = `Context: ${sharedContext}\n\nYour task: ${task.description}\n\nYou are agent "${agentLabel}" — one of ${tasks.length} parallel agents. Focus on YOUR specific task only.${channelNote}\n\nWhen done, call report_done (if available) or state your task is complete.`;

        useClaudeStore.getState().createSession(
          childSessionId,
          childName,
          true,
          childRuntime.inheritSkipOpenwolf,
          appDir,
          childRuntime.provider,
          true,
        );
        useClaudeStore.getState().setSelectedModel(childSessionId, childRuntime.selectedModel);
        useClaudeStore.getState().setSelectedEffort(childSessionId, childRuntime.selectedEffort);
        if (childRuntime.provider === "openai") {
          useClaudeStore.getState().setSelectedCodexPermission(childSessionId, childRuntime.selectedCodexPermission);
        }
        addUserMessage(childSessionId, initialPrompt);

        setTimeout(() => {
          const startChild = async () => {
            const turnInput = await prepareDelegationChildProviderTurnInput({
              ...childRuntime,
              sessionId: childSessionId,
              cwd: appDir,
              prompt: initialPrompt,
              mcp: {
                delegationPort,
                delegationSecret,
                groupId: group.id,
                agentLabel,
              },
            });
            await runProviderTurn(turnInput);
          };

          startChild().catch((err) => {
            console.warn(`[delegation] Failed to start child ${childSessionId}:`, err);
            delStore.updateTaskStatus(group.id, task.id, "failed", String(err));
          });
        }, i * 500);
      });
    },
    [
      sessionId,
      effectiveCwd,
      selectedProvider,
      permissionMode,
      selectedModel,
      selectedEffort,
      selectedCodexPermission,
      addUserMessage,
    ],
  );
}
