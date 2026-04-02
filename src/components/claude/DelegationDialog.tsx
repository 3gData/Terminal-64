import { useState, useRef, useEffect } from "react";
import "./Delegation.css";

interface TaskInput {
  id: number;
  description: string;
}

interface DelegationDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: (tasks: { description: string }[], mergeStrategy: "auto" | "manual", sharedContext: string) => void;
}

let nextId = 1;

export default function DelegationDialog({ isOpen, onClose, onConfirm }: DelegationDialogProps) {
  const [tasks, setTasks] = useState<TaskInput[]>([
    { id: nextId++, description: "" },
    { id: nextId++, description: "" },
  ]);
  const [sharedContext, setSharedContext] = useState("");
  const [mergeStrategy, setMergeStrategy] = useState<"auto" | "manual">("auto");
  const firstInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isOpen) {
      setTasks([{ id: nextId++, description: "" }, { id: nextId++, description: "" }]);
      setSharedContext("");
      setMergeStrategy("auto");
      setTimeout(() => firstInputRef.current?.focus(), 50);
    }
  }, [isOpen]);

  if (!isOpen) return null;

  const addTask = () => {
    setTasks((prev) => [...prev, { id: nextId++, description: "" }]);
  };

  const removeTask = (id: number) => {
    if (tasks.length <= 1) return;
    setTasks((prev) => prev.filter((t) => t.id !== id));
  };

  const updateTask = (id: number, description: string) => {
    setTasks((prev) => prev.map((t) => (t.id === id ? { ...t, description } : t)));
  };

  const validTasks = tasks.filter((t) => t.description.trim());
  const canConfirm = validTasks.length >= 1;

  const handleConfirm = () => {
    if (!canConfirm) return;
    onConfirm(
      validTasks.map((t) => ({ description: t.description.trim() })),
      mergeStrategy,
      sharedContext.trim(),
    );
    onClose();
  };

  return (
    <div className="del-dialog-overlay" onClick={onClose}>
      <div className="del-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="del-dialog-header">
          <span className="del-dialog-title">Delegate Tasks</span>
          <button className="del-dialog-close" onClick={onClose}>
            <svg width="9" height="9" viewBox="0 0 9 9">
              <path d="M1 1L8 8M8 1L1 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          </button>
        </div>

        <div className="del-dialog-body">
          {/* Shared context */}
          <label className="del-label">Shared Context <span className="del-label-hint">(sent to all sub-sessions)</span></label>
          <textarea
            className="del-textarea"
            value={sharedContext}
            onChange={(e) => setSharedContext(e.target.value)}
            placeholder="Describe the overall goal or context that all tasks share..."
            rows={3}
          />

          {/* Task list */}
          <label className="del-label">Tasks <span className="del-label-hint">({validTasks.length} valid)</span></label>
          <div className="del-task-list">
            {tasks.map((task, i) => (
              <div key={task.id} className="del-task-row">
                <span className="del-task-num">{i + 1}.</span>
                <input
                  ref={i === 0 ? firstInputRef : undefined}
                  className="del-task-input"
                  value={task.description}
                  onChange={(e) => updateTask(task.id, e.target.value)}
                  placeholder={`Task ${i + 1} description...`}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      if (i === tasks.length - 1) addTask();
                    }
                  }}
                />
                <button
                  className="del-task-remove"
                  onClick={() => removeTask(task.id)}
                  disabled={tasks.length <= 1}
                  title="Remove task"
                >
                  x
                </button>
              </div>
            ))}
          </div>
          <button className="del-add-task" onClick={addTask}>+ Add Task</button>

          {/* Merge strategy */}
          <label className="del-label">Merge Strategy</label>
          <div className="del-strategy-row">
            <button
              className={`del-strategy-btn ${mergeStrategy === "auto" ? "del-strategy-btn--active" : ""}`}
              onClick={() => setMergeStrategy("auto")}
            >
              Auto — merge when all tasks finish
            </button>
            <button
              className={`del-strategy-btn ${mergeStrategy === "manual" ? "del-strategy-btn--active" : ""}`}
              onClick={() => setMergeStrategy("manual")}
            >
              Manual — click to merge
            </button>
          </div>
        </div>

        <div className="del-dialog-footer">
          <button className="del-cancel" onClick={onClose}>Cancel</button>
          <button className="del-confirm" onClick={handleConfirm} disabled={!canConfirm}>
            Delegate {validTasks.length} Task{validTasks.length !== 1 ? "s" : ""}
          </button>
        </div>
      </div>
    </div>
  );
}
