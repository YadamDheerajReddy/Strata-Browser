// Frontend-only tab shape for Phase 1 chrome. This deliberately does not
// attempt to mirror the full `tabs` table from the Backend Schema doc yet
// (no window_id, split_group_id, etc.) — that wiring arrives once Rust's
// TabManager is the source of truth and this store just reflects it.
export interface Tab {
  id: string;
  // CEF's own browser identifier for this tab (see src-tauri/src/cef_bridge.rs)
  // — every backend call (navigate, close, activate, get_tab_state) is keyed
  // off this, not the frontend-local `id` above.
  browserId: number;
  title: string;
  url: string;
  isLoading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
}
