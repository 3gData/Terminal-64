import {
  providerCancel,
  providerClose,
  providerCreate,
  providerSend,
} from "../tauriApi";
import type { PermissionMode } from "../types";
import type { CreateCursorRequest, SendCursorPromptRequest } from "../../contracts/providerIpc";
import type {
  ProviderRuntime,
  ProviderTurnInput,
  ProviderTurnResult,
} from "../../contracts/providerRuntime";
import { getProviderTurnResumeId } from "../../contracts/providerRuntime";

function stringControlValue(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

declare module "../../contracts/providerIpc" {
  interface ProviderCreateRequestMap {
    cursor: CreateCursorRequest;
  }

  interface ProviderSendRequestMap {
    cursor: SendCursorPromptRequest;
  }
}

function cursorForceForPermission(permissionId: string | null | undefined, override?: PermissionMode): boolean {
  const selected = override ?? permissionId;
  return selected === "bypass_all" || selected === "accept_edits" || selected === "auto";
}

function cursorModeForInput(input: ProviderTurnInput<"cursor">): "ask" | "plan" | undefined {
  if (input.permissionOverride === "plan" || input.permissionMode === "plan") return "plan";
  const selectedMode = stringControlValue(input.selectedControls?.mode);
  if (selectedMode === "ask" || selectedMode === "plan") return selectedMode;
  return undefined;
}

export function buildCursorRequest(input: ProviderTurnInput<"cursor">): CreateCursorRequest {
  const options = input.providerOptions?.cursor;
  const selectedModel = stringControlValue(input.selectedControls?.model);
  const force = cursorForceForPermission(
    input.providerPermissionId,
    input.permissionOverride ?? input.permissionMode,
  );
  const mode = cursorModeForInput(input);
  const threadId = getProviderTurnResumeId(input);
  return {
    session_id: input.sessionId,
    cwd: input.cwd,
    prompt: input.prompt,
    permission_mode: input.permissionOverride ?? input.permissionMode ?? "default",
    ...(threadId ? { thread_id: threadId } : {}),
    ...(selectedModel && selectedModel !== "auto" ? { model: selectedModel } : {}),
    ...(mode ? { mode } : {}),
    ...(force ? { force: true } : {}),
    ...(options?.mcpEnv ? { mcp_env: options.mcpEnv } : {}),
  };
}

function seedResult(input: ProviderTurnInput<"cursor">): ProviderTurnResult {
  return { clearSeedTranscript: !!input.seedTranscript?.length };
}

async function create(input: ProviderTurnInput<"cursor">): Promise<ProviderTurnResult> {
  const req = buildCursorRequest(input);
  await providerCreate({ provider: "cursor", req }, input.skipOpenwolf);
  return seedResult(input);
}

async function send(input: ProviderTurnInput<"cursor">): Promise<ProviderTurnResult> {
  const req: SendCursorPromptRequest = buildCursorRequest(input);
  await providerSend({ provider: "cursor", req }, input.skipOpenwolf);
  return seedResult(input);
}

export const cursorRuntime: ProviderRuntime<"cursor"> = {
  provider: "cursor",

  create,

  send,

  cancel(sessionId) {
    return providerCancel("cursor", sessionId);
  },

  close(sessionId) {
    return providerClose("cursor", sessionId);
  },

  history: {
    source: "local-transcript",
    capabilities: {
      hydrate: false,
      fork: false,
      rewind: false,
      delete: false,
    },
  },
};
