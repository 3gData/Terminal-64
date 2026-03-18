import { useSettingsStore } from "../stores/settingsStore";

const SYSTEM_PROMPT = `You are a prompt engineering expert. Your job is to rewrite user prompts to get dramatically better results from AI coding assistants like Claude Code.

Rules:
- Keep the user's INTENT exactly the same
- Make the prompt more specific, structured, and actionable
- Add context that was implied but not stated
- Break vague requests into clear, concrete steps
- Specify expected output format when helpful
- Add constraints that prevent common failure modes (e.g., "don't create new files unless necessary", "use existing patterns in the codebase")
- If the prompt references code, remind the AI to read relevant files first
- Keep it concise — longer isn't better, clearer is better
- Don't add fluff or meta-commentary, just output the improved prompt
- Output ONLY the rewritten prompt, nothing else`;

export async function rewritePromptStream(
  prompt: string,
  onChunk: (text: string) => void
): Promise<void> {
  const { openaiApiKey, openaiModel } = useSettingsStore.getState();

  if (!openaiApiKey) {
    throw new Error("OpenAI API key not set. Add it in Settings.");
  }

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${openaiApiKey}`,
    },
    body: JSON.stringify({
      model: openaiModel || "gpt-5.4-mini",
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: prompt },
      ],
      temperature: 0.7,
      max_completion_tokens: 2048,
      stream: true,
    }),
  });

  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(err.error?.message || `API error: ${response.status}`);
  }

  const reader = response.body?.getReader();
  if (!reader) throw new Error("No response stream");

  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data: ")) continue;
      const data = trimmed.slice(6);
      if (data === "[DONE]") return;

      try {
        const parsed = JSON.parse(data);
        const content = parsed.choices?.[0]?.delta?.content;
        if (content) onChunk(content);
      } catch {}
    }
  }
}
