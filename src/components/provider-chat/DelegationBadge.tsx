import { useDelegationStore } from "../../stores/delegationStore";
import { useCanvasStore } from "../../stores/canvasStore";
import {
  getProviderPermissionId,
  getProviderSelectedControlValues,
  getProviderSessionRuntimeMetadata,
  resolveSessionProviderState,
  useProviderSessionStore,
  type ClaudeSession,
} from "../../stores/providerSessionStore";
import { runProviderTurn } from "../../lib/providerRuntime";
import type { ProviderTurnInput, ProviderTurnResult } from "../../contracts/providerRuntime";
import "./Delegation.css";

interface DelegationBadgeProps {
  sessionId: string;
}

function providerTurnForSession(
  sessionId: string,
  session: ClaudeSession,
  prompt: string,
): ProviderTurnInput {
  const providerState = resolveSessionProviderState(session);
  return {
    provider: providerState.provider,
    sessionId,
    cwd: session.cwd || ".",
    prompt,
    started: session.hasBeenStarted,
    runtimeMetadata: getProviderSessionRuntimeMetadata(providerState, providerState.provider),
    selectedControls: getProviderSelectedControlValues(providerState, providerState.provider),
    providerPermissionId: getProviderPermissionId(providerState, providerState.provider),
    permissionMode: "auto",
    permissionOverride: "bypass_all",
    skipOpenwolf: session.skipOpenwolf,
    seedTranscript: providerState.seedTranscript,
    resumeAtUuid: session.resumeAtUuid ?? null,
    forkParentSessionId: session.forkParentSessionId ?? null,
  };
}

function applyProviderTurnResult(sessionId: string, result: ProviderTurnResult) {
  const store = useProviderSessionStore.getState();
  if (result.clearSeedTranscript) store.clearSeedTranscript(sessionId);
  if (result.clearResumeAtUuid) store.setResumeAtUuid(sessionId, null);
  if (result.clearForkParentSessionId) store.setForkParentSessionId(sessionId, null);
}

export default function DelegationBadge({ sessionId }: DelegationBadgeProps) {
  const group = useDelegationStore((s) => s.getGroupForSession(sessionId));
  const parentSession = useProviderSessionStore((s) =>
    group ? s.sessions[group.parentSessionId] : undefined
  );

  if (!group) return null;

  const task = group.tasks.find((t) => t.sessionId === sessionId);
  if (!task) return null;

  const parentName = parentSession?.name || "Parent";

  const jumpToParent = () => {
    const canvas = useCanvasStore.getState();
    const term = canvas.terminals.find((t) => t.terminalId === group.parentSessionId);
    if (term) canvas.bringToFront(term.id);
  };

  const sendToSiblings = () => {
    const session = useProviderSessionStore.getState().sessions[sessionId];
    if (!session) return;
    const msgs = session.messages;
    const lastAssistant = [...msgs].reverse().find((m) => m.role === "assistant");
    if (!lastAssistant) return;

    const siblings = useDelegationStore.getState().getSiblingSessionIds(sessionId);
    const summary = lastAssistant.content.length > 800
      ? lastAssistant.content.slice(0, 800) + "..."
      : lastAssistant.content;
    const forwardMsg = `[Update from "${task.description}"]: ${summary}`;

    for (const sibId of siblings) {
      const sibSession = useProviderSessionStore.getState().sessions[sibId];
      if (!sibSession) continue;
      if (sibSession.isStreaming) {
        useProviderSessionStore.getState().enqueuePrompt(sibId, {
          displayText: forwardMsg,
          providerPrompt: forwardMsg,
          permissionOverride: "bypass_all",
          command: { kind: "delegation-forward", sourceSessionId: sessionId, originalText: forwardMsg },
        });
      } else {
        runProviderTurn(providerTurnForSession(sibId, sibSession, forwardMsg))
          .then((result) => applyProviderTurnResult(sibId, result))
          .catch((err) => console.warn("[delegation] Manual forward failed:", err));
      }
    }
  };

  return (
    <div className="del-badge">
      <span className={`del-badge-dot del-badge-dot--${task.status}`} />
      <span className="del-badge-task" title={task.description}>
        {task.description.length > 30 ? task.description.slice(0, 30) + "..." : task.description}
      </span>
      <button className="del-badge-parent" onClick={jumpToParent} title={`Jump to ${parentName}`}>
        {parentName}
      </button>
      <button className="del-badge-forward" onClick={sendToSiblings} title="Send last response to siblings">
        <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
          <path d="M1 5H7M7 5L4 2M7 5L4 8" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/>
        </svg>
      </button>
    </div>
  );
}
