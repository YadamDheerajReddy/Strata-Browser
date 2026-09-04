// Frontend-only tab shape for Phase 1/2 chrome. This deliberately does not
// attempt to mirror the full `tabs` table from the Backend Schema doc yet
// (no window_id, split_group_id, etc.) — that wiring arrives once Rust's
// TabManager is the source of truth and this store just reflects it.

// "web" is a real CEF-backed page. "history"/"downloads"/"home" are internal
// pages rendered by React itself (see HistoryPanel/DownloadsPanel/HomePage)
// — "history"/"downloads" open as ordinary tabs (App Flow doc's "a new
// page", not an overlay), and "home" is what a fresh tab starts as instead
// of a real page. None of the three have a CEF browser behind them.
export type TabKind = "web" | "history" | "downloads" | "home";

export interface Tab {
  id: string;
  // CEF's own browser identifier for this tab (see src-tauri/src/cef_bridge.rs)
  // — every backend call (navigate, close, activate, get_tab_state) is keyed
  // off this, not the frontend-local `id` above. null for internal ("history"
  // /"downloads") tabs, which have no CEF browser.
  browserId: number | null;
  kind: TabKind;
  title: string;
  url: string;
  isLoading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  faviconUrl: string | null;
  // Private/incognito tab (App Flow doc §9): its own in-memory-only CEF
  // request context (native/cef_bridge/src/strata_bridge.cpp) and, on the
  // frontend, simply never reported to record_visit and never shown
  // "Continue" history on its home page — see tabsStore and HomePage.
  isPrivate: boolean;
  // Its renderer process crashed/was killed/ran out of memory
  // (Implementation Plan Phase 6's crash recovery — see tabsStore's
  // markCrashed) — the CEF browser itself survives and can still be
  // reloaded, but shows nothing until then, so a "web" tab in this state
  // is treated like an internal page and gets a real recovery UI instead
  // (see CrashedPagePanel).
  crashed: boolean;
  // "crashed" | "killed" | "oom" | "abnormal" — see cef_bridge.rs's
  // CrashEvent. null until the tab actually crashes.
  crashReason: string | null;
}
