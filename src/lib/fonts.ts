export const FONT_OPTIONS: { id: string; label: string; stack: string }[] = [
  { id: "system", label: "System (Segoe UI)", stack: "'Segoe UI', system-ui, -apple-system, sans-serif" },
  { id: "inter", label: "Inter", stack: "Inter, 'Segoe UI', system-ui, sans-serif" },
  { id: "mono", label: "Cascadia Code", stack: "'Cascadia Code', Consolas, monospace" },
  { id: "jetbrains", label: "JetBrains Mono", stack: "'JetBrains Mono', 'Cascadia Code', Consolas, monospace" },
  { id: "fira", label: "Fira Code", stack: "'Fira Code', 'Cascadia Code', monospace" },
  { id: "helvetica", label: "Helvetica", stack: "Helvetica, Arial, sans-serif" },
  { id: "verdana", label: "Verdana", stack: "Verdana, Geneva, sans-serif" },
  { id: "tahoma", label: "Tahoma", stack: "Tahoma, Geneva, sans-serif" },
  { id: "trebuchet", label: "Trebuchet MS", stack: "'Trebuchet MS', Helvetica, sans-serif" },
  { id: "georgia", label: "Georgia", stack: "Georgia, 'Times New Roman', serif" },
  { id: "garamond", label: "Garamond", stack: "Garamond, 'Times New Roman', serif" },
  { id: "comic", label: "Comic Sans", stack: "'Comic Sans MS', cursive, sans-serif" },
];

export function fontStack(id: string): string {
  return FONT_OPTIONS.find((f) => f.id === id)?.stack || FONT_OPTIONS[0]!.stack;
}
