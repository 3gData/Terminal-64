import { create } from "zustand";
import { v4 as uuidv4 } from "uuid";
import type {
  DelegateTaskStatus,
  DelegationChildCleanupState,
  DelegationChildRuntimeMetadata,
  DelegationGroup,
  DelegationStatus,
} from "../lib/types";

const STORAGE_KEY = "terminal64-delegations";
const COMPLETED_GROUP_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_PERSISTED_GROUPS = 40;
const MAX_PERSISTED_RESULT_CHARS = 200_000;
const MAX_PERSISTED_ACTION_CHARS = 1_000;
const MAX_PERSISTED_CONTEXT_CHARS = 100_000;

interface DelegationState {
  groups: Record<string, DelegationGroup>;
  sessionToGroup: Record<string, string>; // child sessionId → groupId
  parentToGroup: Record<string, string>; // parent sessionId → groupId

  createGroup: (
    parentSessionId: string,
    tasks: { description: string }[],
    mergeStrategy: "auto" | "manual",
    sharedContext?: string,
    parentPermissionMode?: string,
  ) => DelegationGroup;
  setTaskSessionId: (
    groupId: string,
    taskId: string,
    sessionId: string,
    childRuntime?: DelegationChildRuntimeMetadata,
  ) => void;
  setTaskChildRuntime: (
    groupId: string,
    taskId: string,
    childRuntime: DelegationChildRuntimeMetadata,
  ) => void;
  setTaskCleanupState: (
    groupId: string,
    taskId: string,
    cleanupState: DelegationChildCleanupState,
  ) => void;
  updateTaskStatus: (groupId: string, taskId: string, status: DelegateTaskStatus, result?: string) => void;
  setTaskForwarded: (groupId: string, taskId: string, messageId: string) => void;
  setTaskAction: (groupId: string, taskId: string, action: string) => void;
  setGroupStatus: (groupId: string, status: DelegationStatus) => void;
  removeGroup: (groupId: string) => void;
  getGroupForSession: (sessionId: string) => DelegationGroup | undefined;
  getGroupByParent: (parentSessionId: string) => DelegationGroup | undefined;
  isChildSession: (sessionId: string) => boolean;
  getSiblingSessionIds: (sessionId: string) => string[];
}

type IdleDeadlineLike = { didTimeout: boolean; timeRemaining: () => number };
type WindowWithIdleCallback = Window & typeof globalThis & {
  requestIdleCallback?: (callback: (deadline: IdleDeadlineLike) => void, options?: { timeout: number }) => number;
  cancelIdleCallback?: (handle: number) => void;
};

let lastSavedGroupsJson: string | null = null;

function scheduleIdle(callback: () => void): number {
  const w = window as WindowWithIdleCallback;
  if (typeof w.requestIdleCallback === "function") {
    return w.requestIdleCallback(() => callback(), { timeout: 2000 });
  }
  return window.setTimeout(callback, 0);
}

function cancelIdle(handle: number) {
  const w = window as WindowWithIdleCallback;
  if (typeof w.cancelIdleCallback === "function") {
    w.cancelIdleCallback(handle);
  } else {
    window.clearTimeout(handle);
  }
}

function truncateForStorage(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)}\n\n[truncated for Terminal 64 metadata persistence; full task history remains in session logs]`;
}

function groupLastActivity(group: DelegationGroup): number {
  let last = group.createdAt;
  for (const task of group.tasks) {
    last = Math.max(last, task.completedAt ?? 0, task.startedAt ?? 0, task.lastActionAt ?? 0);
  }
  return last;
}

function compactGroupForStorage(group: DelegationGroup): DelegationGroup {
  return {
    ...group,
    ...(group.sharedContext !== undefined
      ? { sharedContext: truncateForStorage(group.sharedContext, MAX_PERSISTED_CONTEXT_CHARS) }
      : {}),
    tasks: group.tasks.map((task) => ({
      ...task,
      ...(task.result !== undefined
        ? { result: truncateForStorage(task.result, MAX_PERSISTED_RESULT_CHARS) }
        : {}),
      ...(task.lastAction !== undefined
        ? { lastAction: truncateForStorage(task.lastAction, MAX_PERSISTED_ACTION_CHARS) }
        : {}),
    })),
  };
}

function pruneGroups(groups: Record<string, DelegationGroup>): Record<string, DelegationGroup> {
  const now = Date.now();
  const entries = Object.entries(groups)
    .filter(([, group]) => {
      if (group.status === "active" || group.status === "merging") return true;
      return now - groupLastActivity(group) <= COMPLETED_GROUP_RETENTION_MS;
    })
    .sort((a, b) => groupLastActivity(b[1]) - groupLastActivity(a[1]));

  const kept: Record<string, DelegationGroup> = {};
  let completedKept = 0;
  for (const [id, group] of entries) {
    const active = group.status === "active" || group.status === "merging";
    if (!active) {
      if (completedKept >= MAX_PERSISTED_GROUPS) continue;
      completedKept++;
    }
    kept[id] = compactGroupForStorage(group);
  }
  return kept;
}

function saveToStorage(groups: Record<string, DelegationGroup>) {
  try {
    const json = JSON.stringify(pruneGroups(groups));
    if (json === lastSavedGroupsJson) return;
    localStorage.setItem(STORAGE_KEY, json);
    lastSavedGroupsJson = json;
  } catch (e) {
    console.warn("[delegation] Failed to save to localStorage:", e);
  }
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;
let idleSaveHandle: number | null = null;
let savePending = false;

function flushPendingSave() {
  if (idleSaveHandle !== null) return;
  idleSaveHandle = scheduleIdle(() => {
    idleSaveHandle = null;
    if (!savePending) return;
    savePending = false;
    saveToStorage(useDelegationStore.getState().groups);
    if (savePending) flushPendingSave();
  });
}

function debouncedSave() {
  savePending = true;
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    flushPendingSave();
  }, 1000);
}

function loadFromStorage(): Record<string, DelegationGroup> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      lastSavedGroupsJson = raw;
      return pruneGroups(JSON.parse(raw) as Record<string, DelegationGroup>);
    }
  } catch (e) {
    console.warn("[delegation] Failed to load from localStorage:", e);
  }
  return {};
}

// Build reverse index from groups
function buildSessionIndex(groups: Record<string, DelegationGroup>): Record<string, string> {
  const idx: Record<string, string> = {};
  for (const [gid, group] of Object.entries(groups)) {
    for (const task of group.tasks) {
      if (task.sessionId) idx[task.sessionId] = gid;
    }
  }
  return idx;
}

function buildParentIndex(groups: Record<string, DelegationGroup>): Record<string, string> {
  const idx: Record<string, string> = {};
  for (const [gid, group] of Object.entries(groups)) {
    if (!idx[group.parentSessionId]) idx[group.parentSessionId] = gid;
  }
  return idx;
}

const initialGroups = loadFromStorage();

export const useDelegationStore = create<DelegationState>((set, get) => ({
  groups: initialGroups,
  sessionToGroup: buildSessionIndex(initialGroups),
  parentToGroup: buildParentIndex(initialGroups),

  createGroup: (parentSessionId, tasks, mergeStrategy, sharedContext, parentPermissionMode) => {
    const group: DelegationGroup = {
      id: uuidv4(),
      parentSessionId,
      tasks: tasks.map((t) => ({
        id: uuidv4(),
        description: t.description,
        sessionId: "",
        status: "pending" as DelegateTaskStatus,
      })),
      mergeStrategy,
      status: "active",
      createdAt: Date.now(),
      ...(sharedContext !== undefined && { sharedContext }),
      collaborationEnabled: true,
      parentPermissionMode: (parentPermissionMode as DelegationGroup["parentPermissionMode"]) || "auto",
    };
    set((s) => {
      const groups = { ...s.groups, [group.id]: group };
      const parentToGroup = { ...s.parentToGroup, [parentSessionId]: group.id };
      debouncedSave();
      return { groups, parentToGroup };
    });
    return group;
  },

  setTaskSessionId: (groupId, taskId, sessionId, childRuntime) => {
    set((s) => {
      const group = s.groups[groupId];
      if (!group) return s;
      const tasks = group.tasks.map((t) =>
        t.id === taskId
          ? {
              ...t,
              sessionId,
              ...(childRuntime !== undefined ? { childRuntime } : {}),
            }
          : t,
      );
      const groups = { ...s.groups, [groupId]: { ...group, tasks } };
      const sessionToGroup = { ...s.sessionToGroup, [sessionId]: groupId };
      debouncedSave();
      return { groups, sessionToGroup };
    });
  },

  setTaskChildRuntime: (groupId, taskId, childRuntime) => {
    set((s) => {
      const group = s.groups[groupId];
      if (!group) return s;
      const tasks = group.tasks.map((t) => (t.id === taskId ? { ...t, childRuntime } : t));
      const groups = { ...s.groups, [groupId]: { ...group, tasks } };
      debouncedSave();
      return { groups };
    });
  },

  setTaskCleanupState: (groupId, taskId, cleanupState) => {
    set((s) => {
      const group = s.groups[groupId];
      if (!group) return s;
      const tasks = group.tasks.map((t) =>
        t.id === taskId && t.childRuntime
          ? {
              ...t,
              childRuntime: {
                ...t.childRuntime,
                cleanupState,
                cleanupUpdatedAt: Date.now(),
              },
            }
          : t,
      );
      const groups = { ...s.groups, [groupId]: { ...group, tasks } };
      debouncedSave();
      return { groups };
    });
  },

  updateTaskStatus: (groupId, taskId, status, result) => {
    set((s) => {
      const group = s.groups[groupId];
      if (!group) return s;
      const now = Date.now();
      const tasks = group.tasks.map((t) =>
        t.id === taskId
          ? {
              ...t,
              status,
              ...(result !== undefined ? { result } : {}),
              ...(status === "running" && !t.startedAt ? { startedAt: now } : {}),
              ...(status === "completed" || status === "failed" ? { completedAt: now } : {}),
            }
          : t,
      );
      const groups = { ...s.groups, [groupId]: { ...group, tasks } };
      debouncedSave();
      return { groups };
    });
  },

  setTaskForwarded: (groupId, taskId, messageId) => {
    set((s) => {
      const group = s.groups[groupId];
      if (!group) return s;
      const tasks = group.tasks.map((t) =>
        t.id === taskId ? { ...t, lastForwardedMessageId: messageId } : t,
      );
      const groups = { ...s.groups, [groupId]: { ...group, tasks } };
      debouncedSave();
      return { groups };
    });
  },

  setTaskAction: (groupId, taskId, action) => {
    set((s) => {
      const group = s.groups[groupId];
      if (!group) return s;
      const task = group.tasks.find((t) => t.id === taskId);
      if (task?.lastAction === action) return s;
      const tasks = group.tasks.map((t) =>
        t.id === taskId ? { ...t, lastAction: action, lastActionAt: Date.now() } : t,
      );
      const groups = { ...s.groups, [groupId]: { ...group, tasks } };
      debouncedSave();
      return { groups };
    });
  },

  setGroupStatus: (groupId, status) => {
    set((s) => {
      const group = s.groups[groupId];
      if (!group) return s;
      const groups = { ...s.groups, [groupId]: { ...group, status } };
      debouncedSave();
      return { groups };
    });
  },

  removeGroup: (groupId) => {
    set((s) => {
      const { [groupId]: removed, ...rest } = s.groups;
      if (!removed) return s;
      const sessionToGroup = { ...s.sessionToGroup };
      for (const task of removed.tasks) {
        if (task.sessionId) delete sessionToGroup[task.sessionId];
      }
      const parentToGroup = { ...s.parentToGroup };
      delete parentToGroup[removed.parentSessionId];
      debouncedSave();
      return { groups: rest, sessionToGroup, parentToGroup };
    });
  },

  getGroupForSession: (sessionId) => {
    const { groups, sessionToGroup } = get();
    const gid = sessionToGroup[sessionId];
    return gid ? groups[gid] : undefined;
  },

  getGroupByParent: (parentSessionId) => {
    const { groups, parentToGroup } = get();
    const gid = parentToGroup[parentSessionId];
    if (!gid) return undefined;
    const group = groups[gid];
    return group && group.status !== "cancelled" ? group : undefined;
  },

  isChildSession: (sessionId) => {
    return !!get().sessionToGroup[sessionId];
  },

  getSiblingSessionIds: (sessionId) => {
    const group = get().getGroupForSession(sessionId);
    if (!group) return [];
    return group.tasks
      .filter((t) => t.sessionId && t.sessionId !== sessionId && t.status === "running")
      .map((t) => t.sessionId);
  },
}));

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    if (idleSaveHandle !== null) {
      cancelIdle(idleSaveHandle);
      idleSaveHandle = null;
    }
  });
}
