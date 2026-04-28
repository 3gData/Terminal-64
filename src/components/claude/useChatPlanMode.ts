import { useCallback, useEffect, useRef, useState } from "react";
import { useClaudeStore } from "../../stores/claudeStore";
import type { ProviderId } from "../../lib/providers";
import type { ChatMessage, PermissionMode, ToolCall } from "../../lib/types";

export interface CodexPlanCommand {
  prompt: string;
  collaborationMode: "plan";
}

interface UseChatPlanModeArgs {
  sessionId: string;
  session: ChatPlanSession | undefined;
  provider: ProviderId;
  onPermissionModeChange: (permissionId: PermissionMode) => void;
}

interface ChatPlanSession {
  messages: ChatMessage[];
  isStreaming: boolean;
  planModeActive: boolean;
}

function isClaudePlanPath(path: string): boolean {
  return path.includes(".claude/plans/") || path.includes(".claude\\plans\\");
}

function planContentFromToolCall(toolCall: ToolCall): string | null {
  if (!["Write", "Edit", "MultiEdit", "Read"].includes(toolCall.name)) return null;
  const filePath = toolCall.input.file_path;
  if (typeof filePath !== "string" || !isClaudePlanPath(filePath)) return null;
  if (toolCall.name === "Read" && toolCall.result) return toolCall.result;

  const content = toolCall.input.content ?? toolCall.input.new_string;
  return typeof content === "string" ? content : null;
}

function extractCodexPlanContent(text: string): string | null {
  const match = text.match(/<proposed_plan>\s*([\s\S]*?)\s*<\/proposed_plan>/i);
  return match?.[1]?.trim() || null;
}

function detectPlanInCurrentTurn(session: ChatPlanSession, provider: ProviderId, scanFrom: number): {
  content: string | null;
  turnStart: number;
} {
  const messages = session.messages;
  let turnStart = scanFrom;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]!.role === "user") {
      turnStart = i;
      break;
    }
  }

  for (let i = messages.length - 1; i >= turnStart; i--) {
    const msg = messages[i];
    if (!msg || msg.role !== "assistant") continue;

    if (provider === "openai") {
      const codexPlan = extractCodexPlanContent(msg.content);
      if (codexPlan) return { content: codexPlan, turnStart };
    }

    for (const toolCall of msg.toolCalls ?? []) {
      const toolPlan = planContentFromToolCall(toolCall);
      if (toolPlan) return { content: toolPlan, turnStart };
    }
  }

  return { content: null, turnStart };
}

export function parseCodexPlanCommand(text: string, provider: ProviderId): CodexPlanCommand | null {
  if (provider !== "openai") return null;
  const match = text.match(/^\/plan(?:\s+([\s\S]*))?$/i);
  if (!match) return null;
  return {
    collaborationMode: "plan",
    prompt: match[1]?.trim() || "Create a plan.",
  };
}

export function useChatPlanMode({
  sessionId,
  session,
  provider,
  onPermissionModeChange,
}: UseChatPlanModeArgs) {
  const [planContent, setPlanContent] = useState<string | null>(null);
  const [planFinished, setPlanFinished] = useState(false);
  const [showPlanViewer, setShowPlanViewer] = useState(false);
  const wasPlanMode = useRef(false);
  const wasStreaming = useRef(false);
  const planShownThisTurn = useRef(false);
  const planScanFrom = useRef(0);

  const resetPlan = useCallback(() => {
    setPlanFinished(false);
    setShowPlanViewer(false);
    setPlanContent(null);
  }, []);

  const clearPlanContent = useCallback(() => {
    setPlanContent(null);
  }, []);

  const togglePlanViewer = useCallback(() => {
    setShowPlanViewer((value) => !value);
  }, []);

  useEffect(() => {
    if (!session) return;
    const detected = detectPlanInCurrentTurn(session, provider, planScanFrom.current);
    planScanFrom.current = detected.turnStart;
    if (!detected.content) return;

    setPlanContent(detected.content);
    if (!session.isStreaming && wasStreaming.current && !planFinished && !planShownThisTurn.current) {
      planShownThisTurn.current = true;
      setPlanFinished(true);
    }
  }, [provider, session?.messages, session?.isStreaming, planFinished, session]);

  // React to Claude Code EnterPlanMode/ExitPlanMode tool calls.
  useEffect(() => {
    if (!session) return;
    if (session.planModeActive) {
      wasPlanMode.current = true;
      onPermissionModeChange("plan");
    } else if (wasPlanMode.current) {
      wasPlanMode.current = false;
      setPlanFinished(true);
      onPermissionModeChange("default");
    }
  }, [session?.planModeActive, onPermissionModeChange, session]);

  // If streaming ends while plan mode is still active, Claude did not call
  // ExitPlanMode. Treat the turn as plan completion so the action bar appears.
  useEffect(() => {
    if (!session) return;
    if (session.isStreaming) {
      wasStreaming.current = true;
      planShownThisTurn.current = false;
    } else if (wasStreaming.current) {
      wasStreaming.current = false;
      if (session.planModeActive) {
        useClaudeStore.getState().setPlanMode(sessionId, false);
      } else if (planContent && !planFinished && !planShownThisTurn.current) {
        planShownThisTurn.current = true;
        setPlanFinished(true);
      }
    }
  }, [session?.isStreaming, session?.planModeActive, sessionId, planContent, planFinished, session]);

  return {
    planContent,
    planFinished,
    showPlanViewer,
    hasPlan: planContent !== null,
    clearPlanContent,
    resetPlan,
    togglePlanViewer,
  };
}
