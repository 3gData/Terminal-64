import type { ProviderId } from "./providers";
import { anthropicRuntime } from "./providerRuntimes/anthropic";
import {
  codexPermissionForOverride,
  openaiRuntime,
  promptWithCodexSeed,
} from "./providerRuntimes/openai";
import type {
  ProviderForkInput,
  ProviderForkResult,
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
} satisfies Record<ProviderId, ProviderRuntime>;

export function getProviderRuntime(provider: ProviderId): ProviderRuntime {
  return PROVIDER_RUNTIMES[provider];
}

export function providerTurnOperation(input: ProviderTurnInput): "create" | "send" {
  return input.started || input.threadId || input.forkParentSessionId ? "send" : "create";
}

export async function runProviderTurn(input: ProviderTurnInput): Promise<ProviderTurnResult> {
  const runtime = getProviderRuntime(input.provider);
  if (providerTurnOperation(input) === "send") {
    return runtime.send(input);
  }
  return runtime.create(input);
}

export function cancelProviderSession(sessionId: string, provider: ProviderId): Promise<void> {
  return getProviderRuntime(provider).cancel(sessionId);
}

export function closeProviderSession(sessionId: string, provider: ProviderId): Promise<void> {
  return getProviderRuntime(provider).close(sessionId);
}

export function truncateProviderHistory(
  input: ProviderHistoryTruncateInput,
): Promise<ProviderHistoryTruncateResult> {
  return getProviderRuntime(input.provider).rewind(input);
}

export function prepareProviderFork(input: ProviderForkInput): Promise<ProviderForkResult> {
  return getProviderRuntime(input.provider).fork(input);
}

export function hydrateProviderHistory(input: ProviderHydrateInput): Promise<ProviderHydrateResult> {
  return getProviderRuntime(input.provider).hydrate(input);
}
