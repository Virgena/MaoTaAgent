import { useCallback, useEffect, useState } from "react";

const STORAGE_KEY = "maota.sidebar.sections";

interface SidebarSections {
  pinned: boolean;
  chats: boolean;
  archived: boolean;
  projects: string[];
}

const DEFAULT_SECTIONS: SidebarSections = {
  pinned: true,
  chats: true,
  archived: true,
  projects: [],
};

function storedSections(): SidebarSections {
  try {
    const raw = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "null") as Partial<SidebarSections> | null;
    if (raw === null) return DEFAULT_SECTIONS;
    return {
      pinned: raw.pinned !== false,
      chats: raw.chats !== false,
      archived: raw.archived !== false,
      projects: Array.isArray(raw.projects)
        ? raw.projects.filter((item): item is string => typeof item === "string")
        : [],
    };
  } catch {
    return DEFAULT_SECTIONS;
  }
}

export function useSidebarSections() {
  const [sections, setSections] = useState(storedSections);

  useEffect(() => {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(sections));
    } catch {
    }
  }, [sections]);

  const toggleSection = useCallback((key: "pinned" | "chats" | "archived"): void => {
    setSections((current) => ({ ...current, [key]: !current[key] }));
  }, []);

  const toggleProject = useCallback((cwd: string): void => {
    setSections((current) => ({
      ...current,
      projects: current.projects.includes(cwd)
        ? current.projects.filter((item) => item !== cwd)
        : [...current.projects, cwd],
    }));
  }, []);

  return { sections, toggleSection, toggleProject };
}
