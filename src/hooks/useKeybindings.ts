import { useEffect } from "react";
import { Keybinding } from "../lib/types";
import { findMatchingBinding, DEFAULT_KEYBINDINGS } from "../lib/keybindingEngine";
import { executeCommand } from "../lib/commands";

export function useKeybindings(extraBindings?: Keybinding[]) {
  useEffect(() => {
    const bindings = [...DEFAULT_KEYBINDINGS, ...(extraBindings ?? [])];

    function handler(event: KeyboardEvent) {
      const match = findMatchingBinding(event, bindings);
      if (match) {
        event.preventDefault();
        event.stopPropagation();
        executeCommand(match.command, match.args);
      }
    }

    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, [extraBindings]);
}
