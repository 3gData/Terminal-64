import { useCallback, useRef, useState } from "react";
import Editor from "@monaco-editor/react";
import { useThemeStore } from "../../stores/themeStore";
import { isAbsolutePath, joinPath } from "../../lib/platform";

export interface ChatEditOverlayState {
  tcId: string;
  filePath: string;
  fullContent: string;
  changedLines: Set<number>;
}

interface UseChatEditOverlayOptions {
  effectiveCwd: string | undefined;
  getScrollEl: () => HTMLDivElement | null;
  readFileContent: (filePath: string) => Promise<string>;
}

interface ChatEditOverlayProps {
  overlay: ChatEditOverlayState;
  saveFileContent: (filePath: string, content: string) => Promise<void>;
  rememberContent: (tcId: string, content: string) => void;
  onClose: (content: string | null) => void;
}

let monacoThemeForBg = "";

function changedLinesFor(content: string, changedText: string): Set<number> {
  const changed = new Set<number>();
  const idx = content.indexOf(changedText);
  if (idx < 0) return changed;

  const startLine = content.substring(0, idx).split("\n").length;
  const numLines = changedText.split("\n").length;
  for (let i = 0; i < numLines; i += 1) changed.add(startLine + i);
  return changed;
}

function guessLanguage(filePath: string): string {
  const ext = filePath.split(".").pop()?.toLowerCase() || "";
  const map: Record<string, string> = {
    ts: "typescript", tsx: "typescript", js: "javascript", jsx: "javascript",
    rs: "rust", py: "python", go: "go", java: "java", json: "json",
    css: "css", scss: "scss", html: "html", md: "markdown", yaml: "yaml",
    yml: "yaml", toml: "toml", sh: "shell", bash: "shell", zsh: "shell",
    sql: "sql", xml: "xml", swift: "swift", kt: "kotlin", rb: "ruby",
    c: "c", cpp: "cpp", h: "c", hpp: "cpp",
  };
  return map[ext] || "plaintext";
}

export function useChatEditOverlay({
  effectiveCwd,
  getScrollEl,
  readFileContent,
}: UseChatEditOverlayOptions) {
  const [editOverlay, setEditOverlay] = useState<ChatEditOverlayState | null>(null);
  const editOverrides = useRef<Record<string, string>>({});
  const savedScrollTop = useRef<number>(0);

  const rememberScrollPosition = useCallback(() => {
    const el = getScrollEl();
    if (el) savedScrollTop.current = el.scrollTop;
  }, [getScrollEl]);

  const restoreScrollPosition = useCallback(() => {
    requestAnimationFrame(() => {
      const el = getScrollEl();
      if (el) el.scrollTop = savedScrollTop.current;
    });
  }, [getScrollEl]);

  const rememberContent = useCallback((tcId: string, content: string) => {
    editOverrides.current[tcId] = content;
  }, []);

  const openEditOverlay = useCallback(async (tcId: string, filePath: string, _oldStr: string, newStr: string) => {
    const resolvedFilePath = filePath && !isAbsolutePath(filePath) && effectiveCwd
      ? joinPath(effectiveCwd, filePath)
      : filePath;

    rememberScrollPosition();

    const cached = editOverrides.current[tcId];
    if (cached) {
      setEditOverlay({
        tcId,
        filePath: resolvedFilePath,
        fullContent: cached,
        changedLines: changedLinesFor(cached, newStr),
      });
      return;
    }

    try {
      const content = await readFileContent(resolvedFilePath);
      setEditOverlay({
        tcId,
        filePath: resolvedFilePath,
        fullContent: content,
        changedLines: changedLinesFor(content, newStr),
      });
    } catch {
      const lines = newStr.split("\n");
      setEditOverlay({
        tcId,
        filePath: resolvedFilePath,
        fullContent: newStr,
        changedLines: new Set(lines.map((_, i) => i + 1)),
      });
    }
  }, [effectiveCwd, readFileContent, rememberScrollPosition]);

  const openFileOverlay = useCallback(async (filePath: string) => {
    rememberScrollPosition();
    try {
      const content = await readFileContent(filePath);
      setEditOverlay({ tcId: `file:${filePath}`, filePath, fullContent: content, changedLines: new Set() });
    } catch (e) {
      console.warn("[claude] Failed to read file for preview:", e);
    }
  }, [readFileContent, rememberScrollPosition]);

  const closeEditOverlay = useCallback((content: string | null) => {
    if (content !== null && editOverlay) {
      editOverrides.current[editOverlay.tcId] = content;
    }
    setEditOverlay(null);
    restoreScrollPosition();
  }, [editOverlay, restoreScrollPosition]);

  return {
    editOverlay,
    openEditOverlay,
    openFileOverlay,
    rememberContent,
    closeEditOverlay,
  };
}

export default function ChatEditOverlay({
  overlay,
  saveFileContent,
  rememberContent,
  onClose,
}: ChatEditOverlayProps) {
  const modifiedEditorRef = useRef<import("monaco-editor").editor.IStandaloneCodeEditor | null>(null);
  const editorSavedVersionId = useRef<number>(0);
  const [editorDirty, setEditorDirty] = useState(false);

  const handleSave = useCallback(() => {
    if (!modifiedEditorRef.current || !editorDirty) return;

    const content = modifiedEditorRef.current.getValue();
    saveFileContent(overlay.filePath, content).catch(() => {});
    rememberContent(overlay.tcId, content);
    editorSavedVersionId.current = modifiedEditorRef.current.getModel()!.getAlternativeVersionId();
    setEditorDirty(false);
  }, [editorDirty, overlay.filePath, overlay.tcId, rememberContent, saveFileContent]);

  const handleClose = useCallback(() => {
    onClose(modifiedEditorRef.current?.getValue() ?? null);
  }, [onClose]);

  return (
    <div className="cc-messages cc-edit-overlay">
      <div className="cc-edit-overlay-header">
        <span className="cc-edit-overlay-path">{overlay.filePath}</span>
        <div className="cc-edit-overlay-actions">
          <span className={`cc-edit-overlay-tag ${editorDirty ? "cc-edit-overlay-tag--unsaved" : "cc-edit-overlay-tag--saved"}`}>{editorDirty ? "Unsaved" : "Saved"}</span>
          <button className="cc-edit-overlay-btn cc-edit-overlay-save" onClick={handleSave}><svg width="12" height="12" viewBox="0 0 16 16" fill="none"><path d="M12.5 2H3.5C2.67 2 2 2.67 2 3.5V12.5C2 13.33 2.67 14 3.5 14H12.5C13.33 14 14 13.33 14 12.5V3.5C14 2.67 13.33 2 12.5 2ZM8 12C6.9 12 6 11.1 6 10S6.9 8 8 8S10 8.9 10 10S9.1 12 8 12ZM11 6H4V3H11V6Z" fill="currentColor"/></svg></button>
          <button className="cc-edit-overlay-btn cc-edit-overlay-close" onClick={handleClose}>Close</button>
        </div>
      </div>
      <div className="cc-edit-overlay-editor">
        <Editor
          value={overlay.fullContent}
          language={guessLanguage(overlay.filePath)}
          theme="terminal64"
          beforeMount={(monaco) => {
            const ui = useThemeStore.getState().currentTheme.ui;
            if (monacoThemeForBg !== ui.bg) {
              monaco.editor.defineTheme("terminal64", {
                base: "vs-dark",
                inherit: true,
                rules: [],
                colors: {
                  "editor.background": ui.bg,
                  "editor.foreground": ui.fg,
                  "editorLineNumber.foreground": ui.fgMuted,
                  "editor.selectionBackground": ui.accent + "44",
                  "editor.lineHighlightBackground": ui.bgSecondary,
                  "editorWidget.background": ui.bgSecondary,
                  "editorWidget.border": ui.border,
                },
              });
              monacoThemeForBg = ui.bg;
            }
          }}
          onMount={(editor, monaco) => {
            modifiedEditorRef.current = editor;
            editorSavedVersionId.current = editor.getModel()!.getAlternativeVersionId();
            setEditorDirty(false);

            if (overlay.changedLines.size > 0) {
              editor.createDecorationsCollection(
                [...overlay.changedLines].map((line) => ({
                  range: new monaco.Range(line, 1, line, 1),
                  options: {
                    isWholeLine: true,
                    className: "cc-editor-changed-line",
                    glyphMarginClassName: "cc-editor-changed-gutter",
                  },
                }))
              );
              const sorted = [...overlay.changedLines].sort((a, b) => a - b);
              const mid = sorted[Math.floor(sorted.length / 2)];
              if (mid !== undefined) editor.revealLineInCenter(mid);
            }

            editor.onDidChangeModelContent(() => {
              setEditorDirty(editor.getModel()!.getAlternativeVersionId() !== editorSavedVersionId.current);
            });
          }}
          options={{
            minimap: { enabled: false },
            fontSize: 12,
            fontFamily: "'Cascadia Code', Consolas, monospace",
            scrollBeyondLastLine: false,
            lineNumbers: "on",
            wordWrap: "on",
            glyphMargin: true,
            folding: false,
            lineDecorationsWidth: 0,
            renderLineHighlight: "none",
            padding: { top: 8, bottom: 8 },
          }}
        />
      </div>
    </div>
  );
}
