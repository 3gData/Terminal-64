import { useCallback, useRef, useState } from "react";
import { usePanelStore, CustomPanel } from "../../stores/panelStore";
import { BORDER_COLORS } from "../../lib/constants";
import "./PanelFrame.css";

interface PanelFrameProps {
  panel: CustomPanel;
}

export default function PanelFrame({ panel }: PanelFrameProps) {
  const movePanel = usePanelStore((s) => s.movePanel);
  const resizePanel = usePanelStore((s) => s.resizePanel);
  const removePanel = usePanelStore((s) => s.removePanel);
  const bringToFront = usePanelStore((s) => s.bringToFront);
  const toggleMinimize = usePanelStore((s) => s.toggleMinimize);
  const closePanel = usePanelStore((s) => s.closePanel);
  const setTitle = usePanelStore((s) => s.setTitle);
  const setBorderColor = usePanelStore((s) => s.setBorderColor);

  const [showColors, setShowColors] = useState(false);
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState("");
  const dragRef = useRef({ startX: 0, startY: 0, origX: 0, origY: 0 });
  const titleInputRef = useRef<HTMLInputElement>(null);

  // Use parent canvas zoom (read from CSS custom property or default to 1)
  const getZoom = useCallback(() => {
    const canvas = document.querySelector(".canvas-content") as HTMLElement;
    if (!canvas) return 1;
    const transform = canvas.style.transform;
    const match = transform.match(/scale\(([^)]+)\)/);
    return match ? parseFloat(match[1]) : 1;
  }, []);

  const handleHeaderMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if ((e.target as HTMLElement).closest(".pf-btn")) return;
      if ((e.target as HTMLElement).closest(".pf-title--editing")) return;
      e.preventDefault();
      e.stopPropagation();
      bringToFront(panel.id);
      setShowColors(false);

      const d = dragRef.current;
      const zoom = getZoom();
      d.startX = e.clientX;
      d.startY = e.clientY;
      d.origX = panel.x;
      d.origY = panel.y;

      const onMove = (ev: MouseEvent) => {
        const dx = (ev.clientX - d.startX) / zoom;
        const dy = (ev.clientY - d.startY) / zoom;
        movePanel(panel.id, d.origX + dx, d.origY + dy);
      };
      const onUp = () => {
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
      };
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
    },
    [panel.id, panel.x, panel.y, movePanel, bringToFront, getZoom]
  );

  const startEdgeResize = useCallback(
    (e: React.MouseEvent, edge: string) => {
      e.preventDefault();
      e.stopPropagation();
      bringToFront(panel.id);

      const zoom = getZoom();
      const startX = e.clientX;
      const startY = e.clientY;
      const origX = panel.x;
      const origY = panel.y;
      const origW = panel.width;
      const origH = panel.height;

      const onMove = (ev: MouseEvent) => {
        const dx = (ev.clientX - startX) / zoom;
        const dy = (ev.clientY - startY) / zoom;

        let newX = origX, newY = origY, newW = origW, newH = origH;

        if (edge.includes("e")) newW = origW + dx;
        if (edge.includes("s")) newH = origH + dy;
        if (edge.includes("w")) { newW = origW - dx; newX = origX + dx; }
        if (edge === "n" || edge === "nw" || edge === "ne") { newH = origH - dy; newY = origY + dy; }

        newW = Math.max(200, newW);
        newH = Math.max(150, newH);
        if (newW === 200 && edge.includes("w")) newX = origX + origW - 200;
        if (newH === 150 && (edge === "n" || edge === "nw" || edge === "ne")) newY = origY + origH - 150;

        resizePanel(panel.id, newW, newH);
        movePanel(panel.id, newX, newY);
      };
      const onUp = () => {
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
      };
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
    },
    [panel.id, panel.x, panel.y, panel.width, panel.height, resizePanel, movePanel, bringToFront, getZoom]
  );

  const handleClose = useCallback(() => {
    closePanel(panel.id);
  }, [panel.id, closePanel]);

  const handleRemove = useCallback(() => {
    removePanel(panel.id);
  }, [panel.id, removePanel]);

  const handleMinimize = useCallback(() => {
    toggleMinimize(panel.id);
  }, [panel.id, toggleMinimize]);

  const handleFocus = useCallback(() => {
    bringToFront(panel.id);
  }, [panel.id, bringToFront]);

  if (!panel.isOpen) return null;

  return (
    <div
      className={`panel-frame ${panel.isMinimized ? "panel-frame--minimized" : ""}`}
      style={{
        left: panel.x,
        top: panel.y,
        width: panel.width,
        height: panel.isMinimized ? 32 : panel.height,
        zIndex: panel.zIndex,
        "--pf-border": panel.borderColor,
      } as React.CSSProperties}
      onMouseDown={handleFocus}
    >
      {/* Header */}
      <div className="pf-header" onMouseDown={handleHeaderMouseDown}>
        {editingTitle ? (
          <>
            <input
              ref={titleInputRef}
              className="pf-title pf-title--editing"
              value={titleDraft}
              onChange={(e) => setTitleDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  setTitle(panel.id, titleDraft.trim() || "Panel");
                  setEditingTitle(false);
                } else if (e.key === "Escape") {
                  setEditingTitle(false);
                }
              }}
              onBlur={() => {
                setTitle(panel.id, titleDraft.trim() || "Panel");
                setEditingTitle(false);
              }}
              onMouseDown={(e) => e.stopPropagation()}
              spellCheck={false}
              autoFocus
            />
          </>
        ) : (
          <>
            <span
              className="pf-title"
              onDoubleClick={(e) => {
                e.stopPropagation();
                setTitleDraft(panel.title);
                setEditingTitle(true);
              }}
            >
              {panel.title}
            </span>
          </>
        )}

        {/* Color picker button */}
        <button
          className="pf-btn pf-btn--settings"
          onClick={(e) => {
            e.stopPropagation();
            setShowColors((v) => !v);
          }}
          title="Border color"
        >
          <div className="pf-color-dot" style={{ background: panel.borderColor }} />
        </button>

        {/* Minimize button */}
        <button className="pf-btn" onClick={handleMinimize} title={panel.isMinimized ? "Restore" : "Minimize"}>
          <svg width="9" height="1" viewBox="0 0 9 1">
            <rect width="9" height="1" fill="currentColor" />
          </svg>
        </button>

        {/* Close (hide) button */}
        <button className="pf-btn" onClick={handleClose} title="Close">
          <svg width="9" height="9" viewBox="0 0 9 9">
            <path d="M1 1L8 8M8 1L1 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
        </button>

        {/* Delete (remove permanently) button */}
        <button className="pf-btn pf-btn--delete" onClick={handleRemove} title="Delete panel">
          <svg width="9" height="10" viewBox="0 0 9 10" fill="none">
            <path d="M1 2.5H8M3 2.5V1.5H6V2.5M2 2.5V9H7V2.5" stroke="currentColor" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
        </button>
      </div>

      {/* Color picker popover */}
      {showColors && (
        <div className="pf-colors" onClick={(e) => e.stopPropagation()}>
          {BORDER_COLORS.map((c) => (
            <button
              key={c}
              className={`pf-color-swatch ${c === panel.borderColor ? "pf-color-swatch--active" : ""}`}
              style={{ background: c }}
              onClick={() => {
                setBorderColor(panel.id, c);
                setShowColors(false);
              }}
            />
          ))}
        </div>
      )}

      {/* Body */}
      {!panel.isMinimized && (
        <div className="pf-body">
          {panel.contentType === "empty" && (
            <div className="pf-empty">
              <span>Empty panel</span>
              <span className="pf-empty-hint">Use /skill to generate content</span>
            </div>
          )}
          {panel.contentType === "html" && (
            <div
              className="pf-html-content"
              dangerouslySetInnerHTML={{ __html: panel.content }}
            />
          )}
          {panel.contentType === "custom" && (
            <div className="pf-custom-content">
              {panel.content}
            </div>
          )}
        </div>
      )}

      {/* Resize handles */}
      {!panel.isMinimized && (
        <>
          <div className="pf-resize pf-resize--n" onMouseDown={(e) => startEdgeResize(e, "n")} />
          <div className="pf-resize pf-resize--s" onMouseDown={(e) => startEdgeResize(e, "s")} />
          <div className="pf-resize pf-resize--w" onMouseDown={(e) => startEdgeResize(e, "w")} />
          <div className="pf-resize pf-resize--e" onMouseDown={(e) => startEdgeResize(e, "e")} />
          <div className="pf-resize pf-resize--nw" onMouseDown={(e) => startEdgeResize(e, "nw")} />
          <div className="pf-resize pf-resize--ne" onMouseDown={(e) => startEdgeResize(e, "ne")} />
          <div className="pf-resize pf-resize--sw" onMouseDown={(e) => startEdgeResize(e, "sw")} />
          <div className="pf-resize pf-resize--se" onMouseDown={(e) => startEdgeResize(e, "se")} />
        </>
      )}
    </div>
  );
}
