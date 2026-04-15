import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { getDelegationMessages } from "../../lib/tauriApi";
import type { DelegationMsg } from "../../lib/types";
import { useDelegationStore } from "../../stores/delegationStore";
import { useClaudeStore } from "../../stores/claudeStore";
import { endDelegation, performMerge } from "../../hooks/useDelegationOrchestrator";
import "./Delegation.css";

interface SharedChatProps {
  groupId: string;
}

function TaskIndicator({ task }: { task: { sessionId?: string; status: string } }) {
  const isThinking = useClaudeStore((s) => task.sessionId ? (s.sessions[task.sessionId]?.isStreaming ?? false) : false);

  if (task.status === "completed") return <span className="sc-task-icon sc-task-icon--done">&#10003;</span>;
  if (task.status === "failed") return <span className="sc-task-icon sc-task-icon--fail">&#10007;</span>;
  if (task.status === "cancelled") return <span className="sc-task-icon sc-task-icon--cancel">&mdash;</span>;
  if (isThinking) return <span className="sc-task-dot" />;
  return <span className="sc-task-icon sc-task-icon--pending">&#9675;</span>;
}

export default function SharedChat({ groupId }: SharedChatProps) {
  const [messages, setMessages] = useState<DelegationMsg[]>([]);
  const group = useDelegationStore((s) => s.groups[groupId]);

  // Load existing messages on mount
  useEffect(() => {
    getDelegationMessages(groupId)
      .then(setMessages)
      .catch(() => {});
  }, [groupId]);

  // Listen for new messages via Tauri events
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let unmounted = false;
    listen<DelegationMsg>("delegation-message", (event) => {
      const msg = event.payload;
      if (msg.group_id === groupId) {
        setMessages((prev) => [...prev, msg]);
      }
    }).then((fn) => {
      if (unmounted) { fn(); } else { unlisten = fn; }
    });
    return () => { unmounted = true; unlisten?.(); };
  }, [groupId]);

  // Auto-scroll on new messages — use scrollTop on the container instead of
  // scrollIntoView, which can bubble up and shift the canvas viewport.
  const messagesRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = messagesRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  if (!group) return null;

  const completedCount = group.tasks.filter((t) => t.status === "completed").length;
  const totalCount = group.tasks.length;
  const allDone = group.tasks.every((t) => t.status === "completed" || t.status === "failed" || t.status === "cancelled");

  return (
    <div className="shared-chat">
      <div className="shared-chat-header">
        <span className="shared-chat-title">Team Chat</span>
        <span className="sc-progress">{completedCount}/{totalCount}</span>
        <span className={`sc-status sc-status--${group.status}`}>{group.status}</span>
        <div className="sc-header-actions">
          {group.status === "active" && !allDone && (
            <button className="sc-btn sc-btn--end" onClick={() => endDelegation(group.id)}>End</button>
          )}
          {group.status === "active" && allDone && group.mergeStrategy === "manual" && (
            <button className="sc-btn sc-btn--merge" onClick={() => performMerge(group.id)}>Merge</button>
          )}
          {group.status === "active" && allDone && group.mergeStrategy === "auto" && (
            <span className="sc-merging">Merging...</span>
          )}
          {(group.status === "merged" || group.status === "cancelled") && (
            <button className="sc-btn sc-btn--dismiss" onClick={() => useDelegationStore.getState().removeGroup(group.id)}>Dismiss</button>
          )}
        </div>
      </div>

      {/* Compact task status bar */}
      <div className="sc-tasks">
        {group.tasks.map((task) => (
          <div key={task.id} className={`sc-task sc-task--${task.status}`}>
            <TaskIndicator task={task} />
            <span className="sc-task-desc">{task.description}</span>
            {task.lastAction && task.status === "running" && (
              <span className="sc-task-action">{task.lastAction}</span>
            )}
          </div>
        ))}
      </div>

      <div className="shared-chat-messages" ref={messagesRef}>
        {messages.length === 0 && (
          <div className="shared-chat-empty">Agents will post updates here as they work...</div>
        )}
        {messages.map((msg, i) => (
          <div key={i} className={`shared-chat-msg shared-chat-msg--${msg.msg_type}`}>
            <span className="shared-chat-agent">{msg.agent}</span>
            <span className="shared-chat-text">{msg.message}</span>
            <span className="shared-chat-time">
              {new Date(msg.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
