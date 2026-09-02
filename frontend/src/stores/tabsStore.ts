import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import type { Tab } from "../types/tab";

let nextTabSeq = 1;

function makeTab(browserId: number, url: string): Tab {
  return {
    id: `tab_${nextTabSeq++}`,
    browserId,
    title: "New Tab",
    url,
    isLoading: true,
    canGoBack: false,
    canGoForward: false,
  };
}

interface BackendTabState {
  url: string;
  title: string;
  canGoBack: boolean;
  canGoForward: boolean;
  isLoading: boolean;
}

interface TabsState {
  tabs: Tab[];
  activeTabId: string | null;

  addTab: (url?: string) => Promise<string>;
  closeTab: (id: string) => Promise<void>;
  setActiveTab: (id: string) => Promise<void>;
  updateTab: (id: string, patch: Partial<Tab>) => void;
  refreshTabState: (id: string) => Promise<void>;
}

// Strata's real homepage (search field + Continue + Moments rows, per
// UI/UX Brief §7) needs Continuum data that doesn't exist until Phase 3/4
// — new tabs land on a plain working page until then.
const DEFAULT_URL = "https://www.google.com";

export const useTabsStore = create<TabsState>((set, get) => ({
  tabs: [],
  activeTabId: null,

  addTab: async (url = DEFAULT_URL) => {
    const browserId = await invoke<number>("create_tab", { url });
    const tab = makeTab(browserId, url);
    set((state) => ({
      tabs: [...state.tabs, tab],
      activeTabId: tab.id,
    }));
    // create_tab only creates+positions the browser; activate_tab is what
    // hides whatever tab was visible before and shows this one.
    await invoke("activate_tab", { browserId });
    return tab.id;
  },

  closeTab: async (id) => {
    const { tabs, activeTabId } = get();
    const index = tabs.findIndex((t) => t.id === id);
    if (index === -1) return;
    const closed = tabs[index];

    const remaining = tabs.filter((t) => t.id !== id);
    let nextActiveId = activeTabId;
    if (activeTabId === id) {
      // Prefer the tab that was to the right, falling back to the left.
      const fallback = remaining[index] ?? remaining[index - 1];
      nextActiveId = fallback ? fallback.id : null;
    }

    set({ tabs: remaining, activeTabId: nextActiveId });
    await invoke("close_tab", { browserId: closed.browserId });

    if (nextActiveId) {
      const next = remaining.find((t) => t.id === nextActiveId);
      if (next) await invoke("activate_tab", { browserId: next.browserId });
    }
  },

  setActiveTab: async (id) => {
    if (get().activeTabId === id) return;
    set({ activeTabId: id });
    const tab = get().tabs.find((t) => t.id === id);
    if (tab) await invoke("activate_tab", { browserId: tab.browserId });
  },

  updateTab: (id, patch) =>
    set((state) => ({
      tabs: state.tabs.map((t) => (t.id === id ? { ...t, ...patch } : t)),
    })),

  // Polls the real CEF-side navigation state (title/url/back/forward/
  // loading) for one tab and syncs it into the store — see App.tsx's
  // polling loop. There's no push-based event for this yet (Phase 1
  // simplification); Phase 2+ can replace this with a real callback.
  refreshTabState: async (id) => {
    const tab = get().tabs.find((t) => t.id === id);
    if (!tab) return;
    const backendState = await invoke<BackendTabState | null>("get_tab_state", {
      browserId: tab.browserId,
    });
    if (!backendState) return;
    get().updateTab(id, {
      url: backendState.url,
      title: backendState.title || "New Tab",
      canGoBack: backendState.canGoBack,
      canGoForward: backendState.canGoForward,
      isLoading: backendState.isLoading,
    });
  },
}));
