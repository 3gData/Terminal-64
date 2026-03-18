import { Command } from "./types";

const commandRegistry = new Map<string, Command>();

export function registerCommand(command: Command) {
  commandRegistry.set(command.id, command);
}

export function executeCommand(id: string, ...args: unknown[]) {
  const cmd = commandRegistry.get(id);
  if (cmd) {
    cmd.execute(...args);
  }
}

export function getCommand(id: string): Command | undefined {
  return commandRegistry.get(id);
}

export function getAllCommands(): Command[] {
  return Array.from(commandRegistry.values());
}

export function searchCommands(query: string): Command[] {
  const q = query.toLowerCase();
  return getAllCommands().filter(
    (cmd) =>
      cmd.label.toLowerCase().includes(q) ||
      cmd.id.toLowerCase().includes(q) ||
      cmd.category?.toLowerCase().includes(q)
  );
}
