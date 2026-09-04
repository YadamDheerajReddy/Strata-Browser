import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useProfilesStore } from "./profilesStore";
import type { Tab } from "../types/tab";

let nextTabSeq = 1;

function makeTab(browserId: number, url: string, isPrivate: boolean): Tab {
  return {
    id: `tab_${nextTabSeq++}`,
    browserId,
    kind: "web",
    title: "New Tab",
    url,
    isLoading: true,
    canGoBack: false,
    canGoForward: false,
    faviconUrl: null,
    isPrivate,
    crashed: false,
    crashReason: null,
  };
}

function makeInternalTab(kind: "history" | "downloads"): Tab {
  return {
    id: `tab_${nextTabSeq++}`,
    browserId: null,
    kind,
    title: kind === "history" ? "History" : "Downloads",
    url: kind === "history" ? "strata://history" : "strata://downloads",
    isLoading: false,
    canGoBack: false,
    canGoForward: false,
    faviconUrl: null,
    isPrivate: false,
    crashed: false,
    crashReason: null,
  };
}

// What a fresh tab actually starts as (Ctrl+T, the "+" button, first
// launch) — Strata's own home page instead of a real page, no CEF browser
// behind it until the user searches/navigates from it (see
// navigateFromHome below). HomePage hides "Continue" for a private one —
// no point showing real browsing history on a page whose whole point is
// not leaving a trace.
function makeHomeTab(isPrivate: boolean): Tab {
  return {
    id: `tab_${nextTabSeq++}`,
    browserId: null,
    kind: "home",
    title: "New Tab",
    url: "",
    isLoading: false,
    canGoBack: false,
    canGoForward: false,
    faviconUrl: null,
    isPrivate,
    crashed: false,
    crashReason: null,
  };
}

interface BackendTabState {
  url: string;
  title: string;
  canGoBack: boolean;
  canGoForward: boolean;
  isLoading: boolean;
  faviconUrl: string | null;
  scrollX: number;
  scrollY: number;
}

interface TabsState {
  tabs: Tab[];
  activeTabId: string | null;

  addTab: (url?: string, isPrivate?: boolean) => Promise<string>;
  // Restore Moment only (lib/moments.ts) — creates every tab in the batch
  // hidden, without switching to any of them in turn the way addTab()
  // always does. Returns the created tab ids in the same order as `urls`;
  // the caller decides when (and which one) to actually reveal via
  // setActiveTab, once its own "Restoring Moment..." transition is done.
  addTabsForRestore: (urls: string[]) => Promise<string[]>;
  openInternalTab: (kind: "history" | "downloads") => Promise<string>;
  navigateFromHome: (id: string, url: string) => Promise<void>;
  // quitIfEmpty lets internal callers (ProfileSwitcher's tab reset) close
  // every tab in a batch without triggering the window close each one
  // would otherwise cause the moment the batch happens to hit zero — see
  // the implementation below.
  closeTab: (id: string, opts?: { quitIfEmpty?: boolean }) => Promise<void>;
  setActiveTab: (id: string) => Promise<void>;
  updateTab: (id: string, patch: Partial<Tab>) => void;
  // Drag-to-reorder in TabBar (framer-motion's Reorder.Group) — just
  // replaces the array wholesale with the order it already computed.
  setTabOrder: (tabs: Tab[]) => void;
  refreshTabState: (id: string) => Promise<void>;
  // Crash recovery (Implementation Plan Phase 6) — called from App.tsx's
  // "tab-crashed" listener. Marks the tab crashed and, if it's the active
  // one, immediately hides its (now-blank) browser in favor of
  // CrashedPagePanel.
  markCrashed: (browserId: number, reason: string) => Promise<void>;
  // Reloads a crashed tab's browser in place (the CefBrowser survives a
  // renderer crash and can be renavigated — see strata_client.cpp's
  // OnRenderProcessTerminated) and, if active, reveals it again.
  reloadCrashedTab: (id: string) => Promise<void>;
}

// Puts the right CEF browser on screen — or, for a History/Downloads/Home
// tab (or a crashed "web" tab, which has nothing to show until reloaded),
// none at all (see set_panel_open in lib.rs for why those need the whole
// webview instead of just the content strip) — for whichever tab just
// became active. Every place that changes activeTabId funnels through this
// so there's exactly one spot that knows how to reconcile the two.
async function syncBackendForActiveTab(tab: Tab | undefined) {
  if (!tab) return;
  if (tab.kind === "web" && !tab.crashed) {
    if (tab.browserId != null) {
      await invoke("activate_tab", { browserId: tab.browserId });
    }
    await invoke("set_panel_open", { open: false });
  } else {
    await invoke("set_panel_open", { open: true });
  }
}

export const useTabsStore = create<TabsState>((set, get) => ({
  tabs: [],
  activeTabId: null,

  // No url (Ctrl+T, the "+" button, first launch) lands on Strata's own
  // home page instead of creating a CEF browser at all — see makeHomeTab
  // and navigateFromHome. isPrivate defaults to whether the window is
  // currently in Guest mode (profilesStore) — every tab in a Guest session
  // is private, the same way every tab in a real browser's Guest window is.
  addTab: async (url, isPrivate = useProfilesStore.getState().isGuest) => {
    if (url == null) {
      const tab = makeHomeTab(isPrivate);
      set((state) => ({ tabs: [...state.tabs, tab], activeTabId: tab.id }));
      await syncBackendForActiveTab(tab);
      if (!isPrivate) void invoke("record_tab_created", { tabId: tab.id });
      return tab.id;
    }
    const browserId = await invoke<number>("create_tab", { url, isPrivate });
    const tab = makeTab(browserId, url, isPrivate);
    set((state) => ({
      tabs: [...state.tabs, tab],
      activeTabId: tab.id,
    }));
    await syncBackendForActiveTab(tab);
    if (!isPrivate) void invoke("record_tab_created", { tabId: tab.id });
    return tab.id;
  },

  addTabsForRestore: async (urls) => {
    // Every browser starts hidden natively now (see strata_bridge.cpp's
    // strata_cef_create_browser) — nothing further needed here to keep
    // this batch invisible until the whole Moment has finished restoring.
    const ids: string[] = [];
    for (const url of urls) {
      const browserId = await invoke<number>("create_tab", { url, isPrivate: false });
      const tab = makeTab(browserId, url, false);
      set((state) => ({ tabs: [...state.tabs, tab] }));
      void invoke("record_tab_created", { tabId: tab.id });
      ids.push(tab.id);
    }
    return ids;
  },

  // History/Downloads always open as a fresh tab (App Flow doc: "a new
  // page"), matching how a real browser's chrome://history behaves rather
  // than the toggleable overlay panel this used to be.
  openInternalTab: async (kind) => {
    const tab = makeInternalTab(kind);
    set((state) => ({
      tabs: [...state.tabs, tab],
      activeTabId: tab.id,
    }));
    await syncBackendForActiveTab(tab);
    return tab.id;
  },

  // Turns a home tab into a real page in place — searching/navigating from
  // Strata's home page replaces it with the result rather than opening a
  // second tab, matching how every browser's own new-tab page behaves.
  navigateFromHome: async (id, url) => {
    const tab = get().tabs.find((t) => t.id === id);
    if (!tab || tab.kind !== "home") return;
    const browserId = await invoke<number>("create_tab", { url, isPrivate: tab.isPrivate });
    get().updateTab(id, {
      kind: "web",
      browserId,
      url,
      title: "New Tab",
      isLoading: true,
    });
    if (get().activeTabId === id) {
      await syncBackendForActiveTab(get().tabs.find((t) => t.id === id));
    }
  },

  closeTab: async (id, opts) => {
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
    lastRecordedUrls.delete(id);
    if (closed.browserId != null) {
      await invoke("close_tab", { browserId: closed.browserId });
    }

    // Closing the last tab closes Strata itself, matching how closing the
    // last window works in most browsers — App Flow doc's "no separate
    // empty-browser state" bias. quitIfEmpty:false is for internal batch
    // closes (ProfileSwitcher resetting tabs before adding a fresh one)
    // that would otherwise hit zero tabs mid-sequence and quit too early.
    if (remaining.length === 0) {
      if (opts?.quitIfEmpty === false) return;
      await getCurrentWindow().close();
      return;
    }

    if (nextActiveId) {
      const next = remaining.find((t) => t.id === nextActiveId);
      await syncBackendForActiveTab(next);
    }
  },

  setActiveTab: async (id) => {
    if (get().activeTabId === id) return;
    set({ activeTabId: id });
    const tab = get().tabs.find((t) => t.id === id);
    await syncBackendForActiveTab(tab);
  },

  updateTab: (id, patch) =>
    set((state) => ({
      tabs: state.tabs.map((t) => (t.id === id ? { ...t, ...patch } : t)),
    })),

  setTabOrder: (tabs) => set({ tabs }),

  // Polls the real CEF-side navigation state (title/url/back/forward/
  // loading/favicon) for one tab and syncs it into the store — see
  // App.tsx's polling loop. There's no push-based event for this yet
  // (Phase 1/2 simplification); Phase 3's EventRecorder is where a proper
  // one belongs. Internal (History/Downloads) tabs have no CEF browser to
  // poll.
  refreshTabState: async (id) => {
    const tab = get().tabs.find((t) => t.id === id);
    if (!tab || tab.kind !== "web" || tab.browserId == null) return;
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
      faviconUrl: backendState.faviconUrl,
    });

    // History (Phase 2): record once a navigation to a *new* URL settles
    // (not loading, has a real title) — piggybacking on this same poll
    // rather than a dedicated CEF-side event, since that's exactly what
    // Phase 3's EventRecorder is scoped to build properly. Private tabs
    // (App Flow doc §9) never get recorded at all.
    if (
      !tab.isPrivate &&
      !backendState.isLoading &&
      backendState.title &&
      backendState.url &&
      backendState.url !== "about:blank" &&
      lastRecordedUrls.get(id) !== backendState.url
    ) {
      lastRecordedUrls.set(id, backendState.url);
      void invoke("record_visit", {
        tabId: id,
        url: backendState.url,
        title: backendState.title,
        faviconUrl: backendState.faviconUrl,
      });
    }

    // StateCollector checkpoint (Implementation Plan Phase 3): piggybacks
    // on this same poll rather than a dedicated scroll-event listener, same
    // "not a proper push model yet" simplification as history above.
    // Throttled to roughly the TRD's 500-1000ms debounce window, and only
    // written when the scroll position actually moved — "record meaningful
    // state changes, not every pixel."
    if (!tab.isPrivate && !backendState.isLoading && backendState.url && backendState.url !== "about:blank") {
      const last = lastScrollCheckpoints.get(id);
      const now = Date.now();
      const moved =
        !last || Math.abs(last.x - backendState.scrollX) > 2 || Math.abs(last.y - backendState.scrollY) > 2;
      const dueForCheckpoint = !last || now - last.at > 1000;
      if (moved && dueForCheckpoint) {
        lastScrollCheckpoints.set(id, { x: backendState.scrollX, y: backendState.scrollY, at: now });
        void invoke("checkpoint_page_state", {
          tabId: id,
          url: backendState.url,
          title: backendState.title,
          faviconUrl: backendState.faviconUrl,
          scrollX: backendState.scrollX,
          scrollY: backendState.scrollY,
        });
      }
    }
  },

  markCrashed: async (browserId, reason) => {
    const { tabs, activeTabId } = get();
    const tab = tabs.find((t) => t.browserId === browserId);
    if (!tab) return;
    get().updateTab(tab.id, { crashed: true, crashReason: reason });
    if (tab.id === activeTabId) {
      await syncBackendForActiveTab({ ...tab, crashed: true });
    }
  },

  reloadCrashedTab: async (id) => {
    const tab = get().tabs.find((t) => t.id === id);
    if (!tab || tab.browserId == null) return;
    await invoke("reload_tab", { browserId: tab.browserId });
    get().updateTab(id, { crashed: false, crashReason: null, isLoading: true });
    if (get().activeTabId === id) {
      await syncBackendForActiveTab({ ...tab, crashed: false });
    }
  },
}));

// Per-tab "last URL we wrote to history" — internal bookkeeping only, kept
// out of the Tab type so components don't need to know about it.
const lastRecordedUrls = new Map<string, string>();

// Per-tab last-written scroll checkpoint — see refreshTabState's
// StateCollector throttle above.
const lastScrollCheckpoints = new Map<string, { x: number; y: number; at: number }>();
