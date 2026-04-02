import { useEffect } from "react";
import { useClaudeStore } from "../stores/claudeStore";
import { useDelegationStore } from "../stores/delegationStore";
import { useCanvasStore } from "../stores/canvasStore";
import { cancelClaude, sendClaudePrompt, cleanupDelegationGroup } from "../lib/tauriApi";

const FORWARDING_PREFIX = "[Update from";
const MAX_SUMMARY_LENGTH = 800;

function closeSharedChatPanel(groupId: string) {
  const canvas = useCanvasStore.getState();
  const panelId = `shared-chat-${groupId}`;
  const panel = canvas.terminals.find((t) => t.terminalId === panelId);
  if (panel) {
    canvas.removeTerminal(panel.id);
  }
}

export function useDelegationOrchestrator() {
  useEffect(() => {
    const unsub = useClaudeStore.subscribe((state, prev) => {
      for (const [sid, session] of Object.entries(state.sessions)) {
        const prevSession = prev.sessions[sid];
        const was = prevSession?.isStreaming ?? false;
        const now = session.isStreaming;

        // Track last tool call action for delegation children
        const delStore = useDelegationStore.getState();
        const group = delStore.getGroupForSession(sid);
        if (group) {
          const task = group.tasks.find((t) => t.sessionId === sid);
          if (task) {
            // Detect new tool calls
            const prevMsgCount = prevSession?.messages.length ?? 0;
            if (session.messages.length > prevMsgCount) {
              const newMsgs = session.messages.slice(prevMsgCount);
              for (const msg of newMsgs) {
                if (msg.role === "assistant" && msg.toolCalls?.length) {
                  const lastTc = msg.toolCalls[msg.toolCalls.length - 1];
                  const detail = lastTc.input?.file_path || lastTc.input?.command || lastTc.input?.pattern || "";
                  const action = `${lastTc.name}${detail ? ` ${String(detail).split("/").pop()?.slice(0, 40)}` : ""}`;
                  delStore.setTaskAction(group.id, task.id, action);
                }
              }
            }
          }
        }

        // Only act on streaming → not-streaming transitions
        if (was && !now) {
          handleTurnComplete(sid);
        }
      }
    });
    return unsub;
  }, []);
}

function handleTurnComplete(sessionId: string) {
  const delStore = useDelegationStore.getState();
  const group = delStore.getGroupForSession(sessionId);
  if (!group || group.status !== "active") return;

  const claudeState = useClaudeStore.getState();
  const session = claudeState.sessions[sessionId];
  if (!session || session.error) return;

  const task = group.tasks.find((t) => t.sessionId === sessionId);
  if (!task || task.status !== "running") return;

  const msgs = session.messages;
  const lastAssistant = [...msgs].reverse().find((m) => m.role === "assistant");
  if (!lastAssistant) return;

  if (task.lastForwardedMessageId === lastAssistant.id) return;
  if (lastAssistant.content.startsWith(FORWARDING_PREFIX)) return;

  delStore.setTaskForwarded(group.id, task.id, lastAssistant.id);

  const isDone = detectCompletion(lastAssistant.content);
  if (isDone) {
    const resultSummary = lastAssistant.content.slice(0, MAX_SUMMARY_LENGTH * 2);
    delStore.updateTaskStatus(group.id, task.id, "completed", resultSummary);
    delStore.setTaskAction(group.id, task.id, "Done");
  }

  // Check if all tasks are complete → merge
  checkAndMerge(group.id);
}

function checkAndMerge(groupId: string) {
  const delStore = useDelegationStore.getState();
  const group = delStore.groups[groupId];
  if (!group || group.status !== "active") return;

  const allDone = group.tasks.every(
    (t) => t.status === "completed" || t.status === "failed" || t.status === "cancelled",
  );
  if (!allDone) return;

  if (group.mergeStrategy === "manual") return;
  performMerge(groupId);
}

export function performMerge(groupId: string) {
  const delStore = useDelegationStore.getState();
  const group = delStore.groups[groupId];
  if (!group) return;

  delStore.setGroupStatus(groupId, "merging");

  const sections = group.tasks.map((t) => {
    const statusLabel = t.status === "completed" ? "Completed" : t.status === "failed" ? "Failed" : "Cancelled";
    const result = t.result || "(no result captured)";
    return `## ${t.description} [${statusLabel}]\n${result}`;
  });

  const mergePrompt = `All delegated tasks have finished. Here are the results:\n\n${sections.join("\n\n---\n\n")}\n\nPlease review these results, summarize what was accomplished, and continue if needed.`;

  const parentSession = useClaudeStore.getState().sessions[group.parentSessionId];
  if (!parentSession) {
    delStore.setGroupStatus(groupId, "merged");
    return;
  }

  if (parentSession.isStreaming) {
    useClaudeStore.getState().enqueuePrompt(group.parentSessionId, mergePrompt);
  } else {
    useClaudeStore.getState().addUserMessage(group.parentSessionId, mergePrompt);
    sendClaudePrompt({
      session_id: group.parentSessionId,
      cwd: parentSession.cwd || ".",
      prompt: mergePrompt,
      permission_mode: "auto",
    }).catch((err) => {
      console.warn("[delegation] Failed to merge to parent:", err);
    });
  }

  delStore.setGroupStatus(groupId, "merged");
  closeSharedChatPanel(groupId);
  cleanupDelegationGroup(groupId).catch(() => {});
}

export function endDelegation(groupId: string) {
  const delStore = useDelegationStore.getState();
  const group = delStore.groups[groupId];
  if (!group) return;

  // Cancel all running children
  for (const task of group.tasks) {
    if (task.status === "running" || task.status === "pending") {
      delStore.updateTaskStatus(groupId, task.id, "cancelled");
      if (task.sessionId) {
        cancelClaude(task.sessionId).catch(() => {});
        // Clean up ephemeral session
        useClaudeStore.getState().removeSession(task.sessionId);
      }
    }
  }

  // If any completed, merge results first
  const hasResults = group.tasks.some((t) => t.status === "completed" && t.result);
  if (hasResults) {
    performMerge(groupId);
  } else {
    delStore.setGroupStatus(groupId, "cancelled");
    closeSharedChatPanel(groupId);
    cleanupDelegationGroup(groupId).catch(() => {});
  }
}

function detectCompletion(content: string): boolean {
  const lower = content.toLowerCase();
  const completionPhrases = [
    "task complete", "task is complete", "i've completed", "i have completed",
    "all done", "finished implementing", "implementation is complete",
    "work is done", "changes are complete", "successfully completed",
  ];
  return completionPhrases.some((phrase) => lower.includes(phrase));
}
