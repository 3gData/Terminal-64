import { renderContent } from "./ChatMessage";

interface PlanViewerProps {
  content: string;
  variant: "main" | "side";
  isStreaming?: boolean;
  onBuild?: () => void;
  onClose?: () => void;
}

interface PlanFinishedActionsProps {
  content: string | null;
  contextPercent: number;
  showViewer: boolean;
  onCompactBuild?: () => void;
  onBuildNow: () => void;
  onToggleViewer: () => void;
  onDelegate: () => void;
  onDismiss: () => void;
}

export function PlanViewer({
  content,
  variant,
  isStreaming = false,
  onBuild,
  onClose,
}: PlanViewerProps) {
  if (variant === "main") {
    return (
      <div className="cc-messages cc-plan-viewer">
        <div className="cc-bubble cc-bubble--assistant">
          {renderContent(content)}
        </div>
      </div>
    );
  }

  return (
    <div className="cc-plan-section">
      <div className="cc-side-header">
        <span>Plan</span>
        <div className="cc-plan-actions">
          <button className="cc-plan-build" onClick={onBuild} disabled={isStreaming}>
            Build
          </button>
          <button className="cc-plan-close" onClick={onClose}>×</button>
        </div>
      </div>
      <div className="cc-plan-body">
        <pre className="cc-plan-content">{content}</pre>
      </div>
    </div>
  );
}

export function PlanFinishedActions({
  content,
  contextPercent,
  showViewer,
  onCompactBuild,
  onBuildNow,
  onToggleViewer,
  onDelegate,
  onDismiss,
}: PlanFinishedActionsProps) {
  return (
    <div className="cc-plan-finished">
      <span className="cc-plan-finished-text">Plan complete</span>
      {contextPercent > 0 && (
        <span className={`cc-plan-ctx ${contextPercent >= 80 ? "cc-plan-ctx--warn" : ""}`}>
          {contextPercent}% context
        </span>
      )}
      <div className="cc-plan-finished-actions">
        {onCompactBuild && (
          <button className="cc-plan-finished-btn cc-plan-finished-btn--accept" onClick={onCompactBuild}>
            Compact &amp; Build
          </button>
        )}
        <button className="cc-plan-finished-btn cc-plan-finished-btn--compact" onClick={onBuildNow}>
          Build Now
        </button>
        {content && (
          <button className="cc-plan-finished-btn cc-plan-finished-btn--view" onClick={onToggleViewer}>
            {showViewer ? "Close Plan" : "View Plan"}
          </button>
        )}
        <button className="cc-plan-finished-btn cc-plan-finished-btn--delegate" onClick={onDelegate}>
          Delegate
        </button>
        <button className="cc-plan-finished-btn cc-plan-finished-btn--dismiss" onClick={onDismiss}>
          Dismiss
        </button>
      </div>
    </div>
  );
}
