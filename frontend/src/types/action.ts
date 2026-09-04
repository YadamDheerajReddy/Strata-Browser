// The full set of chrome-level shortcut actions — shared between App.tsx's
// handleAction (DOM keydown / CEF-forwarded "shortcut" event) and
// CommandPalette, which needs the same union without importing from App.tsx
// itself (that would be circular: App.tsx renders CommandPalette).
export type Action =
  | "new_tab"
  | "new_private_tab"
  | "close_tab"
  | "focus_address_bar"
  | "reload"
  | "bookmark"
  | "history"
  | "downloads"
  | "next_tab"
  | "open_continuum"
  | "save_moment"
  | "freeze_moment"
  | "open_command_palette";
