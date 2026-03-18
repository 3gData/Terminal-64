import { useState, useEffect, useRef, useCallback } from "react";
import { searchCommands, getAllCommands, executeCommand } from "../../lib/commands";
import { Command } from "../../lib/types";
import "./CommandPalette.css";

interface CommandPaletteProps {
  isOpen: boolean;
  onClose: () => void;
}

export default function CommandPalette({ isOpen, onClose }: CommandPaletteProps) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Command[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isOpen) {
      setQuery("");
      setSelectedIndex(0);
      setResults(getAllCommands());
      setTimeout(() => inputRef.current?.focus(), 0);
    }
  }, [isOpen]);

  useEffect(() => {
    if (query) {
      setResults(searchCommands(query));
      setSelectedIndex(0);
    } else {
      setResults(getAllCommands());
    }
  }, [query]);

  const execute = useCallback(
    (cmd: Command) => {
      onClose();
      cmd.execute();
    },
    [onClose]
  );

  const handleKeyDown = (e: React.KeyboardEvent) => {
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        setSelectedIndex((i) => Math.min(i + 1, results.length - 1));
        break;
      case "ArrowUp":
        e.preventDefault();
        setSelectedIndex((i) => Math.max(i - 1, 0));
        break;
      case "Enter":
        e.preventDefault();
        if (results[selectedIndex]) {
          execute(results[selectedIndex]);
        }
        break;
      case "Escape":
        e.preventDefault();
        onClose();
        break;
    }
  };

  if (!isOpen) return null;

  return (
    <div className="command-palette-overlay" onClick={onClose}>
      <div
        className="command-palette"
        onClick={(e) => e.stopPropagation()}
      >
        <input
          ref={inputRef}
          className="command-palette-input"
          placeholder="Type a command..."
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={handleKeyDown}
        />
        <div className="command-palette-results">
          {results.map((cmd, i) => (
            <div
              key={cmd.id}
              className={`command-palette-item ${
                i === selectedIndex ? "selected" : ""
              }`}
              onClick={() => execute(cmd)}
              onMouseEnter={() => setSelectedIndex(i)}
            >
              <span className="command-label">{cmd.label}</span>
              {cmd.category && (
                <span className="command-category">{cmd.category}</span>
              )}
            </div>
          ))}
          {results.length === 0 && (
            <div className="command-palette-empty">No commands found</div>
          )}
        </div>
      </div>
    </div>
  );
}
