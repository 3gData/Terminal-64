import { useCallback, useEffect, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { readFileBase64, savePastedImage } from "../lib/tauriApi";
import { useCanvasStore } from "../stores/canvasStore";
import type { QueuedPromptAttachmentState } from "../stores/providerSessionStore";

const CHAT_DROP_SELECTOR = ".cc-container[data-session-id]";
const IMAGE_FILE_RE = /\.(png|jpe?g|gif|webp|bmp|svg|ico|tiff?)$/i;

interface ChatDropSubscriber {
  setOver: (over: boolean) => void;
  onDrop: (paths: string[]) => void;
  isFallbackActive: () => boolean;
}

const chatDropSubscribers = new Map<string, ChatDropSubscriber>();
let chatDropUnlisten: (() => void) | null = null;
let chatDropListenPromise: Promise<void> | null = null;
let currentChatDropTarget: string | null = null;

function dragPoint(position: { x: number; y: number } | undefined): { x: number; y: number } | null {
  if (!position) return null;
  const scale = window.devicePixelRatio || 1;
  return { x: position.x / scale, y: position.y / scale };
}

function distanceToRect(point: { x: number; y: number }, rect: DOMRect): number {
  const dx = point.x < rect.left ? rect.left - point.x : point.x > rect.right ? point.x - rect.right : 0;
  const dy = point.y < rect.top ? rect.top - point.y : point.y > rect.bottom ? point.y - rect.bottom : 0;
  return Math.hypot(dx, dy);
}

function closestChatSessionAt(position: { x: number; y: number } | undefined): string | null {
  const point = dragPoint(position);
  if (!point) return null;

  const hit = document.elementFromPoint(point.x, point.y)?.closest<HTMLElement>(CHAT_DROP_SELECTOR);
  if (hit?.dataset.sessionId) return hit.dataset.sessionId;

  let best: { sessionId: string; distance: number } | null = null;
  for (const el of Array.from(document.querySelectorAll<HTMLElement>(CHAT_DROP_SELECTOR))) {
    const sessionId = el.dataset.sessionId;
    if (!sessionId) continue;
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) continue;
    const distance = distanceToRect(point, rect);
    if (!best || distance < best.distance) best = { sessionId, distance };
  }
  return best?.sessionId ?? null;
}

function fallbackActiveChatSession(): string | null {
  for (const [sessionId, subscriber] of chatDropSubscribers) {
    if (subscriber.isFallbackActive()) return sessionId;
  }
  return null;
}

function setChatDropTarget(sessionId: string | null) {
  if (currentChatDropTarget === sessionId) return;
  const previous = currentChatDropTarget;
  currentChatDropTarget = sessionId;
  if (previous) chatDropSubscribers.get(previous)?.setOver(false);
  if (sessionId) chatDropSubscribers.get(sessionId)?.setOver(true);
}

function ensureChatDropListener() {
  if (chatDropListenPromise) return;
  const appWindow = getCurrentWebviewWindow();
  chatDropListenPromise = appWindow.onDragDropEvent((event) => {
    const payload = event.payload;
    if (payload.type === "enter" || payload.type === "over") {
      setChatDropTarget(closestChatSessionAt(payload.position) ?? fallbackActiveChatSession());
      return;
    }

    if (payload.type === "leave") {
      setChatDropTarget(null);
      return;
    }

    if (payload.type === "drop") {
      const targetSessionId = closestChatSessionAt(payload.position) ?? fallbackActiveChatSession();
      setChatDropTarget(null);
      if (!targetSessionId) return;
      const subscriber = chatDropSubscribers.get(targetSessionId);
      if (!subscriber) return;
      const paths = payload.paths.filter((p) => !p.toLowerCase().endsWith(".zip"));
      if (paths.length > 0) subscriber.onDrop(paths);
    }
  }).then((fn) => {
    if (chatDropSubscribers.size === 0) {
      fn();
      chatDropListenPromise = null;
      return;
    }
    chatDropUnlisten = fn;
  }).catch((err) => {
    console.warn("[drag-drop]", err);
    chatDropListenPromise = null;
  });
}

function registerChatDropSubscriber(sessionId: string, subscriber: ChatDropSubscriber): () => void {
  chatDropSubscribers.set(sessionId, subscriber);
  ensureChatDropListener();
  return () => {
    const current = chatDropSubscribers.get(sessionId);
    if (current !== subscriber) return;
    chatDropSubscribers.delete(sessionId);
    if (currentChatDropTarget === sessionId) setChatDropTarget(null);
    if (chatDropSubscribers.size === 0 && chatDropUnlisten) {
      chatDropUnlisten();
      chatDropUnlisten = null;
      chatDropListenPromise = null;
    }
  };
}

function imagePreviewMime(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() || "png";
  return ext === "svg" ? "image/svg+xml" : `image/${ext.replace("jpg", "jpeg")}`;
}

interface UseChatAttachmentsOptions {
  sessionId: string;
  isActive: boolean;
}

export function useChatAttachments({ sessionId, isActive }: UseChatAttachmentsOptions) {
  const [attachedFiles, setAttachedFiles] = useState<string[]>([]);
  const [filePreviews, setFilePreviews] = useState<Record<string, string>>({});
  const [isDragOver, setIsDragOver] = useState(false);
  const previewsRef = useRef<Record<string, string>>({});
  const setActiveTerminal = useCanvasStore((s) => s.setActive);

  useEffect(() => {
    previewsRef.current = filePreviews;
  }, [filePreviews]);

  const addImagePreview = useCallback((path: string) => {
    if (!IMAGE_FILE_RE.test(path)) return;
    readFileBase64(path).then((b64) => {
      setFilePreviews((prev) => {
        if (prev[path]) return prev;
        return { ...prev, [path]: `data:${imagePreviewMime(path)};base64,${b64}` };
      });
    }).catch(() => {});
  }, []);

  const addAttachedFiles = useCallback((paths: string[]) => {
    if (paths.length === 0) return;
    setAttachedFiles((prev) => [...prev, ...paths]);
    for (const path of paths) addImagePreview(path);
  }, [addImagePreview]);

  const handleFileDrop = useCallback((paths: string[]) => {
    setActiveTerminal(sessionId);
    addAttachedFiles(paths);
  }, [addAttachedFiles, sessionId, setActiveTerminal]);

  useEffect(() => {
    return registerChatDropSubscriber(sessionId, {
      setOver: setIsDragOver,
      onDrop: handleFileDrop,
      isFallbackActive: () => isActive,
    });
  }, [handleFileDrop, isActive, sessionId]);

  const handleAttach = useCallback(async () => {
    try {
      const selected = await open({ multiple: true, title: "Attach files" });
      if (!selected) return;
      addAttachedFiles(Array.isArray(selected) ? selected : [selected]);
    } catch (e) {
      console.warn("[claude] File picker error:", e);
    }
  }, [addAttachedFiles]);

  const handlePasteImage = useCallback(async (file: File) => {
    try {
      const buf = await file.arrayBuffer();
      const bytes = new Uint8Array(buf);
      let binary = "";
      for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!);
      const base64 = btoa(binary);
      const ext = file.name.split(".").pop() || file.type.split("/")[1] || "png";
      const savedPath = await savePastedImage(base64, ext);
      setAttachedFiles((prev) => [...prev, savedPath]);
      const previewUrl = URL.createObjectURL(file);
      setFilePreviews((prev) => ({ ...prev, [savedPath]: previewUrl }));
    } catch (e) {
      console.error("Failed to paste image:", e);
    }
  }, []);

  const removeAttachedFile = useCallback((index: number) => {
    setAttachedFiles((prev) => {
      const path = prev[index];
      if (path) {
        const preview = previewsRef.current[path];
        if (preview) URL.revokeObjectURL(preview);
        setFilePreviews((current) => {
          const next = { ...current };
          delete next[path];
          return next;
        });
      }
      return prev.filter((_, i) => i !== index);
    });
  }, []);

  const consumeAttachments = useCallback((promptText: string, displayText = promptText): {
    prompt: string;
    displayPrompt: string;
    attachmentState?: QueuedPromptAttachmentState;
  } => {
    if (attachedFiles.length === 0) return { prompt: promptText, displayPrompt: displayText };

    const files = [...attachedFiles];
    const fileList = files.map((f) => `[Attached file: ${f}]`).join("\n");
    const prompt = `${fileList}\n\n${promptText}`;
    const displayPrompt = `${fileList}\n\n${displayText}`;
    Object.values(previewsRef.current).forEach((url) => URL.revokeObjectURL(url));
    previewsRef.current = {};
    setAttachedFiles([]);
    setFilePreviews({});
    return { prompt, displayPrompt, attachmentState: { expanded: true, files } };
  }, [attachedFiles]);

  useEffect(() => {
    return () => {
      Object.values(previewsRef.current).forEach((url) => URL.revokeObjectURL(url));
      previewsRef.current = {};
    };
  }, []);

  return {
    attachedFiles,
    filePreviews,
    isDragOver,
    handleAttach,
    handlePasteImage,
    removeAttachedFile,
    consumeAttachments,
  };
}
