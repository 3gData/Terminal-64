import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

export async function rewritePromptStream(
  prompt: string,
  onChunk: (text: string) => void
): Promise<void> {
  let resolveDone: () => void;
  const donePromise = new Promise<void>((r) => { resolveDone = r; });

  // Start the rewrite — returns a unique ID to filter events
  const rewriteId: string = await invoke("rewrite_prompt", { prompt });

  // Listen for chunks and done, filtered by rewrite ID
  const unChunk = await listen<{ id: string; text: string }>("rewrite-chunk", (event) => {
    if (event.payload.id === rewriteId) onChunk(event.payload.text);
  });

  const unDone = await listen<{ id: string }>("rewrite-done", (event) => {
    if (event.payload.id === rewriteId) resolveDone();
  });

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      donePromise,
      new Promise<void>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Rewrite timed out")), 120000);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    unChunk();
    unDone();
  }
}
