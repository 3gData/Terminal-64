import type { ProviderHistorySource, ProviderId } from "./providers";
import { anthropicRuntime } from "./providerRuntimes/anthropic";
import { cursorRuntime } from "./providerRuntimes/cursor";
import {
  codexPermissionForOverride,
  openaiRuntime,
  promptWithCodexSeed,
} from "./providerRuntimes/openai";
import type {
  ProviderHistoryCapability,
  ProviderForkInput,
  ProviderForkResult,
  ProviderHistoryDeleteInput,
  ProviderHistoryDeleteResult,
  ProviderHistoryTruncateInput,
  ProviderHistoryTruncateResult,
  ProviderHydrateInput,
  ProviderHydrateResult,
  ProviderRuntime,
  ProviderTurnInput,
  ProviderTurnResult,
} from "../contracts/providerRuntime";

export { codexPermissionForOverride, promptWithCodexSeed };

const PROVIDER_RUNTIMES = {
  anthropic: anthropicRuntime,
  openai: openaiRuntime,
  cursor: cursorRuntime,
} satisfies Record<ProviderId, ProviderRuntime>;

export function getProviderRuntime(provider: ProviderId): ProviderRuntime {
  return PROVIDER_RUNTIMES[provider];
}

export function providerTurnOperation(input: ProviderTurnInput): "create" | "send" {
  return input.started || input.threadId || input.forkParentSessionId ? "send" : "create";
}

export async function prepareProviderTurnInput(input: ProviderTurnInput): Promise<ProviderTurnInput> {
  const runtime = getProviderRuntime(input.provider);
  return runtime.prepareTurn ? runtime.prepareTurn(input) : input;
}

export async function runProviderTurn(input: ProviderTurnInput): Promise<ProviderTurnResult> {
  const preparedInput = await prepareProviderTurnInput(input);
  const runtime = getProviderRuntime(preparedInput.provider);
  if (providerTurnOperation(preparedInput) === "send") {
    return runtime.send(preparedInput);
  }
  return runtime.create(preparedInput);
}

export function cancelProviderSession(sessionId: string, provider: ProviderId): Promise<void> {
  return getProviderRuntime(provider).cancel(sessionId);
}

export function closeProviderSession(sessionId: string, provider: ProviderId): Promise<void> {
  return getProviderRuntime(provider).close(sessionId);
}

function unsupportedHistoryReason(provider: ProviderId, capability: ProviderHistoryCapability): string {
  return `${provider} does not support history ${capability}`;
}

export function providerHistorySupports(provider: ProviderId, capability: ProviderHistoryCapability): boolean {
  return getProviderRuntime(provider).history.capabilities[capability];
}

export function providerHistorySource(provider: ProviderId): ProviderHistorySource {
  return getProviderRuntime(provider).history.source;
}

export function truncateProviderHistory(
  input: ProviderHistoryTruncateInput,
): Promise<ProviderHistoryTruncateResult> {
  const runtime = getProviderRuntime(input.provider);
  const rewind = runtime.history.rewind;
  if (!runtime.history.capabilities.rewind || !rewind) {
    return Promise.resolve({
      status: "unsupported",
      reason: unsupportedHistoryReason(input.provider, "rewind"),
    });
  }
  return rewind(input);
}

export function prepareProviderFork(input: ProviderForkInput): Promise<ProviderForkResult> {
  const runtime = getProviderRuntime(input.provider);
  const fork = runtime.history.fork;
  if (!runtime.history.capabilities.fork || !fork) {
    return Promise.resolve({
      status: "unsupported",
      reason: unsupportedHistoryReason(input.provider, "fork"),
    });
  }
  return fork(input);
}

export function hydrateProviderHistory(input: ProviderHydrateInput): Promise<ProviderHydrateResult> {
  const runtime = getProviderRuntime(input.provider);
  const hydrate = runtime.history.hydrate;
  if (!runtime.history.capabilities.hydrate || !hydrate) {
    return Promise.resolve({
      status: "unsupported",
      reason: unsupportedHistoryReason(input.provider, "hydrate"),
      clearCache: true,
    });
  }
  return hydrate(input);
}

export function deleteProviderHistory(
  input: ProviderHistoryDeleteInput,
): Promise<ProviderHistoryDeleteResult> {
  const runtime = getProviderRuntime(input.provider);
  const deleteHistory = runtime.history.deleteHistory;
  if (!runtime.history.capabilities.delete || !deleteHistory) {
    return Promise.resolve({
      status: "unsupported",
      method: "unsupported",
      reason: unsupportedHistoryReason(input.provider, "delete"),
    });
  }
  return deleteHistory(input);
}
