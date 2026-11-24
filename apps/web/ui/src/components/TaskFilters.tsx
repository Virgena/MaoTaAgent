import { useState } from "react";

import { useT } from "../lib/i18n.ts";
import type { TaskActivity, TaskFilters as FilterValue, TaskGroup, TaskSort, TaskStatus } from "../taskList.ts";
import { Popover } from "./Popover.tsx";

type Section = "status" | "activity" | "group" | "sort";

export function TaskFilters({
  value,
  onChange,
  align = "end",
  outside = false,
}: {
  value: FilterValue;
  onChange: (value: FilterValue) => void;
  align?: "start" | "end";
  outside?: boolean;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [section, setSection] = useState<Section | null>(null);
  const statusLabel = {
    active: t("taskStatusActive"),
    archived: t("taskStatusArchived"),
    all: t("taskStatusAll"),
  }[value.status];
  const activityLabel = {
    all: t("activityAll"),
    day: t("activityToday"),
    week: t("activityWeek"),
    month: t("activityMonth"),
  }[value.activity];
  const groupLabel = {
    none: t("groupNone"),
    project: t("groupProject"),
  }[value.group];
  const sortLabel = {
    activity: t("sortLastActivity"),
    title: t("sortTitle"),
  }[value.sort];
  const choose = (next: string): void => {
    if (section === "status") onChange({ ...value, status: next as TaskStatus });
    if (section === "activity") onChange({ ...value, activity: next as TaskActivity });
    if (section === "group") onChange({ ...value, group: next as TaskGroup });
    if (section === "sort") onChange({ ...value, sort: next as TaskSort });
    setSection(null);
  };
  const options = section === "status"
    ? [
        { value: "active", label: t("taskStatusActive") },
        { value: "archived", label: t("taskStatusArchived") },
        { value: "all", label: t("taskStatusAll") },
      ]
    : section === "activity"
      ? [
          { value: "all", label: t("activityAll") },
          { value: "day", label: t("activityToday") },
          { value: "week", label: t("activityWeek") },
          { value: "month", label: t("activityMonth") },
        ]
      : section === "group"
        ? [
            { value: "none", label: t("groupNone") },
            { value: "project", label: t("groupProject") },
          ]
        : section === "sort"
          ? [
              { value: "activity", label: t("sortLastActivity") },
              { value: "title", label: t("sortTitle") },
            ]
          : [];
  const current = section === "status"
    ? value.status
    : section === "activity"
      ? value.activity
      : section === "group"
        ? value.group
        : value.sort;
  const sectionLabel = section === "status"
    ? t("taskStatus")
    : section === "activity"
      ? t("lastActivity")
      : section === "group"
        ? t("groupBy")
        : t("sortBy");

  return (
    <Popover
      className="task-filter-popover"
      title={t("filterTasks")}
      align={align}
      outside={outside}
      open={open}
      onToggle={() => {
        if (open) setSection(null);
        setOpen(!open);
      }}
      onClose={() => {
        setSection(null);
        setOpen(false);
      }}
      label={<mao-icon name="list-filter" size={16} />}
    >
      {section === null ? (
        <>
          <button type="button" className="task-filter-row" onClick={() => setSection("status")}>
            <span>{t("taskStatus")}</span>
            <span className="task-filter-value">{statusLabel}<mao-icon name="chevron-right" size={14} /></span>
          </button>
          <button type="button" className="task-filter-row" onClick={() => setSection("activity")}>
            <span>{t("lastActivity")}</span>
            <span className="task-filter-value">{activityLabel}<mao-icon name="chevron-right" size={14} /></span>
          </button>
          <button type="button" className="task-filter-row" onClick={() => setSection("group")}>
            <span>{t("groupBy")}</span>
            <span className="task-filter-value">{groupLabel}<mao-icon name="chevron-right" size={14} /></span>
          </button>
          <button type="button" className="task-filter-row" onClick={() => setSection("sort")}>
            <span>{t("sortBy")}</span>
            <span className="task-filter-value">{sortLabel}<mao-icon name="chevron-right" size={14} /></span>
          </button>
        </>
      ) : (
        <>
          <button type="button" className="task-filter-row is-back" onClick={() => setSection(null)}>
            <mao-icon name="chevron-left" size={14} />
            <span>{sectionLabel}</span>
          </button>
          {options.map((option) => (
            <button
              key={option.value}
              type="button"
              className={`task-filter-row${option.value === current ? " is-on" : ""}`}
              onClick={() => choose(option.value)}
            >
              <span>{option.label}</span>
              {option.value === current ? <mao-icon name="check" size={14} /> : null}
            </button>
          ))}
        </>
      )}
    </Popover>
  );
}
