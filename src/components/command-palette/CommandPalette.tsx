import { useCallback, useMemo } from "react";
import { Command as Cmdk } from "cmdk";
import { useSettingsStore, type QuickPaste } from "../../stores/settingsStore";
import { useCanvasStore } from "../../stores/canvasStore";
import { writeTerminal } from "../../lib/tauriApi";
import { executeCommand, getAllCommands } from "../../lib/commands";
import type { Command } from "../../lib/types";
import "./CommandPalette.css";

interface CommandPaletteProps {
  isOpen: boolean;
  onClose: () => void;
}

export default function CommandPalette({ isOpen, onClose }: CommandPaletteProps) {
  const quickPastes = useSettingsStore((s) => s.quickPastes);
  const touchQuickPaste = useSettingsStore((s) => s.touchQuickPaste);
  const activeTerminalId = useCanvasStore((s) => s.activeTerminalId);

  const sortedPastes = useMemo(
    () => [...quickPastes].sort((a, b) => b.lastUsed - a.lastUsed),
    [quickPastes]
  );

  const recentPastes = useMemo(
    () => sortedPastes.filter((q) => q.lastUsed > 0).slice(0, 5),
    [sortedPastes]
  );

  // Re-snapshot the registry whenever the palette opens — commands register
  // asynchronously during App boot and registry contents are not reactive.
  const commands = useMemo<Command[]>(() => (isOpen ? getAllCommands() : []), [isOpen]);

  const groupedCommands = useMemo(() => {
    const groups = new Map<string, Command[]>();
    for (const cmd of commands) {
      const cat = cmd.category ?? "Actions";
      const list = groups.get(cat);
      if (list) list.push(cmd);
      else groups.set(cat, [cmd]);
    }
    return Array.from(groups.entries());
  }, [commands]);

  const runQuickPaste = useCallback(
    (qp: QuickPaste) => {
      if (!activeTerminalId) {
        onClose();
        return;
      }
      touchQuickPaste(qp.id);
      writeTerminal(activeTerminalId, qp.command).catch(() => {});
      onClose();
    },
    [activeTerminalId, touchQuickPaste, onClose]
  );

  const runCommand = useCallback(
    (id: string) => {
      executeCommand(id);
      onClose();
    },
    [onClose]
  );

  const handleOpenChange = (next: boolean) => {
    if (!next) onClose();
  };

  const hasContent = sortedPastes.length > 0 || commands.length > 0;

  return (
    <Cmdk.Dialog
      open={isOpen}
      onOpenChange={handleOpenChange}
      label="Command Palette"
      className="qp-root"
      overlayClassName="qp-overlay"
      contentClassName="qp-dialog"
      loop
    >
      <Cmdk.Input
        className="qp-input"
        placeholder="Search commands, themes, quick pastes…"
        autoFocus
      />
      <Cmdk.List className="qp-list">
        <Cmdk.Empty className="qp-empty">
          {hasContent ? "No matches" : "No commands yet."}
        </Cmdk.Empty>

        {recentPastes.length > 0 && (
          <Cmdk.Group heading="Recent" className="qp-group">
            {recentPastes.map((qp) => (
              <Cmdk.Item
                key={`recent-${qp.id}`}
                value={`recent ${qp.command}`}
                className="qp-item"
                onSelect={() => runQuickPaste(qp)}
              >
                <span className="qp-item-label">{qp.command}</span>
                <kbd className="qp-kbd">↵</kbd>
              </Cmdk.Item>
            ))}
          </Cmdk.Group>
        )}

        {sortedPastes.length > 0 && (
          <Cmdk.Group heading="Quick Pastes" className="qp-group">
            {sortedPastes.map((qp) => (
              <Cmdk.Item
                key={`qp-${qp.id}`}
                value={`paste ${qp.command}`}
                className="qp-item"
                onSelect={() => runQuickPaste(qp)}
              >
                <span className="qp-item-label">{qp.command}</span>
                <kbd className="qp-kbd">paste</kbd>
              </Cmdk.Item>
            ))}
          </Cmdk.Group>
        )}

        {groupedCommands.map(([category, cmds]) => (
          <Cmdk.Group key={category} heading={category} className="qp-group">
            {cmds.map((cmd) => (
              <Cmdk.Item
                key={cmd.id}
                value={`${category} ${cmd.label} ${cmd.id}`}
                className="qp-item"
                onSelect={() => runCommand(cmd.id)}
              >
                <span className="qp-item-label">{cmd.label}</span>
                <kbd className="qp-kbd">{category.toLowerCase()}</kbd>
              </Cmdk.Item>
            ))}
          </Cmdk.Group>
        ))}
      </Cmdk.List>
    </Cmdk.Dialog>
  );
}
