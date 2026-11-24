import type { SessionSummary } from "./lib/rpc.ts";

export type TaskStatus = "active" | "archived" | "all";
export type TaskActivity = "all" | "day" | "week" | "month";
export type TaskGroup = "none" | "project";
export type TaskSort = "activity" | "title";

export interface TaskFilters {
  status: TaskStatus;
  activity: TaskActivity;
  group: TaskGroup;
  sort: TaskSort;
}

export const DEFAULT_TASK_FILTERS: TaskFilters = {
  status: "active",
  activity: "all",
  group: "none",
  sort: "activity",
};

const ACTIVITY_MS: Record<Exclude<TaskActivity, "all">, number> = {
  day: 24 * 60 * 60 * 1000,
  week: 7 * 24 * 60 * 60 * 1000,
  month: 30 * 24 * 60 * 60 * 1000,
};

export function filterTasks(
  sessions: SessionSummary[],
  archivedIds: string[],
  filters: TaskFilters,
  now = Date.now(),
  limit = Number.POSITIVE_INFINITY,
): SessionSummary[] {
  const archived = new Set(archivedIds);
  const cutoff = filters.activity === "all" ? null : now - ACTIVITY_MS[filters.activity];
  const rows = sessions.filter((session) => {
    const isArchived = archived.has(session.id);
    if (filters.status === "active" && isArchived) return false;
    if (filters.status === "archived" && !isArchived) return false;
    if (cutoff === null) return true;
    const updated = Date.parse(session.updated_at);
    return Number.isFinite(updated) && updated >= cutoff;
  });
  rows.sort((left, right) =>
    filters.sort === "title"
      ? (left.title || left.id).localeCompare(right.title || right.id, undefined, { sensitivity: "base" })
      : right.updated_at.localeCompare(left.updated_at));
  return rows.slice(0, limit);
}
