import { useEffect, useState, useMemo } from "react";
import { useDelegationStore } from "../../stores/delegationStore";
import { useClaudeStore } from "../../stores/claudeStore";
import { endDelegation, performMerge } from "../../hooks/useDelegationOrchestrator";
import "./Delegation.css";

interface DelegationStatusProps {
  sessionId: string;
}

function ElapsedTimer({ since }: { since: number | null }) {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    if (!since) { setElapsed(0); return; }
    const tick = () => setElapsed(Math.floor((Date.now() - since) / 1000));
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [since]);
  if (!since) return null;
  const m = Math.floor(elapsed / 60);
  const s = elapsed % 60;
  return <span className="ds-timer">{m > 0 ? `${m}m ${s}s` : `${s}s`}</span>;
}

function TaskRow({ task }: { task: { id: string; sessionId?: string; status: string; description: string; lastAction?: string } }) {
  const childSession = useClaudeStore((s) => task.sessionId ? s.sessions[task.sessionId] : null);
  const isThinking = childSession?.isStreaming ?? false;
  const thinkingSince = childSession?.streamingStartedAt ?? null;

  return (
    <div className={`ds-task ds-task--${task.status}`}>
      <div className="ds-task-indicator">
        {task.status === "completed" ? (
          <span className="ds-check">&#10003;</span>
        ) : task.status === "failed" ? (
          <span className="ds-fail">&#10007;</span>
        ) : task.status === "cancelled" ? (
          <span className="ds-cancel">&mdash;</span>
        ) : isThinking ? (
          <span className="ds-thinking-dot" />
        ) : (
          <span className="ds-pending">&#9675;</span>
        )}
      </div>
      <div className="ds-task-info">
        <div className="ds-task-desc">{task.description}</div>
        <div className="ds-task-meta">
          {isThinking && (
            <>
              <span className="ds-thinking-label">Thinking</span>
              <ElapsedTimer since={thinkingSince} />
            </>
          )}
          {!isThinking && task.status === "running" && task.lastAction && (
            <span className="ds-action">{task.lastAction}</span>
          )}
          {task.status === "completed" && (
            <span className="ds-done-label">Done</span>
          )}
          {task.status === "failed" && (
            <span className="ds-fail-label">Failed</span>
          )}
        </div>
      </div>
    </div>
  );
}

export default function DelegationStatus({ sessionId }: DelegationStatusProps) {
  const group = useDelegationStore((s) => s.getGroupByParent(sessionId));

  if (!group) return null;

  const completedCount = group.tasks.filter((t) => t.status === "completed").length;
  const totalCount = group.tasks.length;
  const allDone = group.tasks.every((t) => t.status === "completed" || t.status === "failed" || t.status === "cancelled");

  return (
    <div className="ds-container">
      <div className="ds-header">
        <span className="ds-title">Delegation</span>
        <span className="ds-progress">{completedCount}/{totalCount}</span>
        <span className={`ds-badge ds-badge--${group.status}`}>{group.status}</span>
      </div>

      <div className="ds-tasks">
        {group.tasks.map((task) => (
          <TaskRow key={task.id} task={task} />
        ))}
      </div>

      <div className="ds-actions">
        {group.status === "active" && !allDone && (
          <button className="ds-btn ds-btn--end" onClick={() => endDelegation(group.id)}>
            End Delegation
          </button>
        )}
        {group.status === "active" && allDone && group.mergeStrategy === "manual" && (
          <button className="ds-btn ds-btn--merge" onClick={() => performMerge(group.id)}>
            Merge Results
          </button>
        )}
        {group.status === "active" && allDone && group.mergeStrategy === "auto" && (
          <span className="ds-merging-label">Merging results...</span>
        )}
        {(group.status === "merged" || group.status === "cancelled") && (
          <button className="ds-btn ds-btn--dismiss" onClick={() => useDelegationStore.getState().removeGroup(group.id)}>
            Dismiss
          </button>
        )}
      </div>
    </div>
  );
}
