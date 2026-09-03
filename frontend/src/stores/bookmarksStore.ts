import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import type { Bookmark } from "../types/bookmark";

interface BookmarksState {
  bookmarks: Bookmark[];
  // The bookmark for whichever URL was last checked via checkCurrent — backs
  // the address bar's filled/outline star (UI/UX Brief §4: the address bar
  // handles "bookmark state" inline, no separate button elsewhere).
  currentBookmark: Bookmark | null;

  refresh: () => Promise<void>;
  checkCurrent: (url: string) => Promise<void>;
  toggle: (url: string, title: string, faviconUrl?: string | null) => Promise<void>;
  remove: (id: string) => Promise<void>;
}

export const useBookmarksStore = create<BookmarksState>((set, get) => ({
  bookmarks: [],
  currentBookmark: null,

  refresh: async () => {
    const bookmarks = await invoke<Bookmark[]>("list_bookmarks");
    set({ bookmarks });
  },

  checkCurrent: async (url) => {
    const bookmark = await invoke<Bookmark | null>("find_bookmark", { url });
    set({ currentBookmark: bookmark });
  },

  toggle: async (url, title, faviconUrl = null) => {
    const existing = get().currentBookmark;
    if (existing && existing.url === url) {
      await invoke("remove_bookmark", { id: existing.id });
      set({ currentBookmark: null });
    } else {
      const created = await invoke<Bookmark>("add_bookmark", {
        url,
        title,
        faviconUrl,
      });
      set({ currentBookmark: created });
    }
    await get().refresh();
  },

  remove: async (id) => {
    await invoke("remove_bookmark", { id });
    const current = get().currentBookmark;
    if (current?.id === id) {
      set({ currentBookmark: null });
    }
    await get().refresh();
  },
}));
