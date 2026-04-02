import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { getDelegationMessages, type DelegationMsg } from "../../lib/tauriApi";
import "./Delegation.css";

interface SharedChatProps {
  groupId: string;
}

export default function SharedChat({ groupId }: SharedChatProps) {
  const [messages, setMessages] = useState<DelegationMsg[]>([]);
  const bottomRef = useRef<HTMLDivElement>(null);

  // Load existing messages on mount
  useEffect(() => {
    getDelegationMessages(groupId)
      .then(setMessages)
      .catch(() => {});
  }, [groupId]);

  // Listen for new messages via Tauri events
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    listen<DelegationMsg & { group_id?: string }>("delegation-message", (event) => {
      const msg = event.payload;
      if ((msg as any).group_id === groupId) {
        setMessages((prev) => [...prev, msg]);
      }
    }).then((fn) => { unlisten = fn; });
    return () => { unlisten?.(); };
  }, [groupId]);

  // Auto-scroll on new messages
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  return (
    <div className="shared-chat">
      <div className="shared-chat-header">
        <span className="shared-chat-title">Team Chat</span>
        <span className="shared-chat-count">{messages.length} messages</span>
      </div>
      <div className="shared-chat-messages">
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
        <div ref={bottomRef} />
      </div>
    </div>
  );
}
