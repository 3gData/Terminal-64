import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useState,
  type KeyboardEventHandler,
  type PointerEventHandler,
  type ReactElement,
  type ReactNode,
  type RefObject,
  type TouchEventHandler,
  type WheelEventHandler,
} from "react";
import { LegendList, type LegendListRef } from "@legendapp/list/react";
import { getProviderManifest, type ProviderId } from "../../lib/providers";
import { useClaudeStore } from "../../stores/claudeStore";
import { formatDuration } from "../../lib/constants";
import ChatMessage, { ToolGroupCard } from "./ChatMessage";
import PromptIsland from "./PromptIsland";
import type { UserPromptRow, VisualRow } from "./useChatRows";

function StreamingBubbleBody({
  sessionId,
  onStreamUpdate,
}: {
  sessionId: string;
  onStreamUpdate: () => void;
}) {
  const text = useClaudeStore((s) => s.sessions[sessionId]?.streamingText);
  useLayoutEffect(() => {
    if (text) onStreamUpdate();
  }, [text, onStreamUpdate]);
  if (!text) return null;
  return (
    <div className="cc-row">
      <div className="cc-message cc-message--assistant">
        <div className="cc-bubble cc-bubble--assistant cc-bubble--streaming">
          {text}
          <span className="cc-cursor" />
        </div>
      </div>
    </div>
  );
}

function CompactDivider({ status, startedAt }: { status: "compacting" | "done"; startedAt: number | null }) {
  const [elapsed, setElapsed] = useState("");
  useEffect(() => {
    if (!startedAt) return;
    const tick = () => setElapsed(formatDuration(Math.floor((Date.now() - startedAt) / 1000)));
    tick();
    if (status === "compacting") {
      const id = setInterval(tick, 1000);
      return () => clearInterval(id);
    }
  }, [status, startedAt]);

  return (
    <div className={`cc-turn-divider cc-compact-divider ${status === "done" ? "cc-compact-divider--done" : ""}`}>
      {status === "compacting" && <span className="cc-compact-spinner" />}
      {status === "done" && <span className="cc-compact-check">&#x2713;</span>}
      <span className="cc-turn-divider-text">
        {status === "compacting" ? "Compacting context" : "Compacted"}
        {elapsed && ` · ${elapsed}`}
      </span>
    </div>
  );
}

interface ChatMessageListProps {
  listRef: RefObject<LegendListRef | null>;
  rows: VisualRow[];
  footer: ReactElement | null;
  sessionId: string;
  provider: ProviderId;
  hasMessages: boolean;
  prompts: UserPromptRow[];
  isScrolledUp: boolean;
  scrollProgress: number;
  islandOpen: boolean;
  onIslandOpen: () => void;
  onIslandClose: () => void;
  onJumpToPrompt: (msgId: string) => void;
  onScrollToBottom: () => void;
  onLegendScroll: () => void;
  onWheel: WheelEventHandler;
  onTouchStart: TouchEventHandler;
  onTouchMove: TouchEventHandler;
  onKeyDown: KeyboardEventHandler;
  onPointerDown: PointerEventHandler;
  onStreamUpdate: () => void;
  onRewind?: (messageId: string, content: string) => void;
  onFork?: (messageId: string) => void;
  onEditClick: (tcId: string, filePath: string, oldStr: string, newStr: string) => void;
}

export default function ChatMessageList({
  listRef,
  rows,
  footer,
  sessionId,
  provider,
  hasMessages,
  prompts,
  isScrolledUp,
  scrollProgress,
  islandOpen,
  onIslandOpen,
  onIslandClose,
  onJumpToPrompt,
  onScrollToBottom,
  onLegendScroll,
  onWheel,
  onTouchStart,
  onTouchMove,
  onKeyDown,
  onPointerDown,
  onStreamUpdate,
  onRewind,
  onFork,
  onEditClick,
}: ChatMessageListProps) {
  const renderRow = useCallback(
    (_idx: number, row: VisualRow) => {
      let inner: ReactNode;
      switch (row.kind) {
        case "turnDivider":
        case "finishedTail":
          inner = (
            <div className="cc-turn-divider">
              <span className="cc-turn-divider-text">
                Finished after {formatDuration(Math.floor(row.dur / 1000))}
              </span>
            </div>
          );
          break;
        case "group":
          inner = (
            <div data-msg-id={row.msgId} className="cc-message cc-message--assistant">
              <div className="cc-tc-list">
                <ToolGroupCard tcs={row.tcs} />
              </div>
            </div>
          );
          break;
        case "message":
          inner = (
            <ChatMessage
              message={row.msg}
              provider={provider}
              {...(onRewind ? { onRewind } : {})}
              {...(onFork ? { onFork } : {})}
              onEditClick={onEditClick}
            />
          );
          break;
        case "compact":
          inner = <CompactDivider status={row.status} startedAt={row.startedAt} />;
          break;
        case "streaming":
          return <StreamingBubbleBody sessionId={sessionId} onStreamUpdate={onStreamUpdate} />;
      }
      return <div className="cc-row">{inner}</div>;
    },
    [onEditClick, onFork, onRewind, onStreamUpdate, provider, sessionId],
  );

  const legendKey = useCallback((row: VisualRow) => row.key, []);
  const legendRenderItem = useCallback(
    ({ item, index }: { item: VisualRow; index: number }) => renderRow(index, item),
    [renderRow],
  );

  return (
    <div className="cc-scroll-frame">
      {!hasMessages ? (
        <div className="cc-messages">
          <div className="cc-empty">
            <div className="cc-empty-icon">
              <svg width="32" height="32" viewBox="0 0 32 32" fill="none">
                <path d="M5 24L13 8L21 18L27 10" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
            </div>
            <span className="cc-empty-text">{getProviderManifest(provider).ui.emptyStateLabel}</span>
            <span className="cc-empty-sub">Send a message, type / for commands, or drop files</span>
          </div>
        </div>
      ) : (
        <LegendList<VisualRow>
          ref={listRef}
          className="cc-messages"
          data={rows}
          keyExtractor={legendKey}
          renderItem={legendRenderItem}
          recycleItems={false}
          estimatedItemSize={120}
          initialScrollAtEnd
          maintainScrollAtEnd
          maintainScrollAtEndThreshold={0.1}
          maintainVisibleContentPosition
          onScroll={onLegendScroll}
          onWheel={onWheel}
          onTouchStart={onTouchStart}
          onTouchMove={onTouchMove}
          onKeyDown={onKeyDown}
          onPointerDown={onPointerDown}
          ListFooterComponent={footer}
        />
      )}
      <PromptIsland
        prompts={prompts}
        isScrolledUp={isScrolledUp}
        progress={scrollProgress}
        open={islandOpen}
        onOpen={onIslandOpen}
        onClose={onIslandClose}
        onJump={onJumpToPrompt}
      />
      <button
        className={`cc-jump-bottom${isScrolledUp && prompts.length > 0 ? "" : " cc-jump-bottom--hidden"}`}
        onClick={onScrollToBottom}
        aria-label="Scroll to bottom"
        title="Scroll to bottom"
      >
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
          <path d="M7 2V11M7 11L3 7M7 11L11 7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
        </svg>
      </button>
    </div>
  );
}
