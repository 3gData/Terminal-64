import type {
  ProviderForkInput,
  ProviderHistoryDeleteInput,
  ProviderHistoryTruncateInput,
  ProviderHydrateInput,
} from "../contracts/providerRuntime";
import type { ChatMessage } from "./types";

const messages: ChatMessage[] = [];

const genericHistoryInputs = {
  rewind: {
    provider: "openai",
    sessionId: "session-1",
    cwd: "/repo",
    keepMessages: 1,
    preMessages: messages,
  },
  fork: {
    provider: "openai",
    parentSessionId: "session-1",
    newSessionId: "session-2",
    cwd: "/repo",
    keepMessages: 1,
    preMessages: messages,
  },
  hydrate: {
    provider: "openai",
    sessionId: "session-1",
    cwd: "/repo",
  },
  delete: {
    provider: "openai",
    sessionId: "session-1",
    cwd: "/repo",
  },
} satisfies {
  rewind: ProviderHistoryTruncateInput;
  fork: ProviderForkInput;
  hydrate: ProviderHydrateInput;
  delete: ProviderHistoryDeleteInput;
};

const codexThreadLeak = {
  provider: "openai",
  sessionId: "session-1",
  cwd: "/repo",
  // @ts-expect-error OpenAI thread metadata is runtime/store-owned, not a common history input field.
  codexThreadId: "thread-1",
} satisfies ProviderHydrateInput;

export function verifyProviderHistoryContractsDoNotRequireCodexFields(): boolean {
  void codexThreadLeak;
  return Object.values(genericHistoryInputs).every(
    (input) => !Object.prototype.hasOwnProperty.call(input, "codexThreadId"),
  );
}
