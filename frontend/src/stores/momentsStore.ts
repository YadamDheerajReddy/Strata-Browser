import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";

export interface MomentTabSummary {
  url: string;
  title: string;
  faviconUrl: string | null;
}

export interface Moment {
  id: string;
  name: string;
  tabCount: number;
  createdAt: number;
  updatedAt: number;
  tabs: MomentTabSummary[];
}

export interface MomentTabDetail extends MomentTabSummary {
  scrollX: number;
  scrollY: number;
}

export interface MomentDetail {
  id: string;
  name: string;
  // Raw JSON (lib.rs's WindowBounds) — parsed by restoreMoment, not here.
  windowLayout: string;
  tabs: MomentTabDetail[];
}

interface MomentsState {
  moments: Moment[];
  // Set/cleared by lib/moments.ts's restoreMoment — read by
  // RestoringMomentOverlay, rendered once at the App root rather than
  // inside HomePage so it survives the tab switch that happens partway
  // through a restore (see restoreMoment's own comments for why the
  // sequencing there matters).
  restoring: { name: string; tabs: string[] } | null;
  refresh: () => Promise<void>;
  remove: (id: string) => Promise<void>;
  rename: (id: string, name: string) => Promise<void>;
}

// MomentManager's read side (Implementation Plan Phase 4) — the write side
// (save/freeze) lives in lib/moments.ts alongside the frontend-owned
// orchestration (gathering live tab state, restoring) that a plain CRUD
// store has no business knowing about.
export const useMomentsStore = create<MomentsState>((set, get) => ({
  moments: [],
  restoring: null,

  refresh: async () => {
    const moments = await invoke<Moment[]>("list_moments");
    set({ moments });
  },

  remove: async (id) => {
    await invoke("delete_moment", { id });
    await get().refresh();
  },

  rename: async (id, name) => {
    await invoke("rename_moment", { id, name });
    await get().refresh();
  },
}));
