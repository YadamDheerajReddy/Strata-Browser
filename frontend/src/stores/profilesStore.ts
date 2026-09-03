import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";

export interface Profile {
  id: string;
  name: string;
  kind: string;
  isEphemeral: boolean;
  avatarColor: string;
}

// "Guest" isn't a real profile row — see ProfileSwitcher.tsx. It behaves
// like private browsing (nothing recorded, in-memory-only CEF data) but is
// presented as a distinct, always-available choice in the switcher rather
// than a per-tab toggle, matching the Implementation Plan's "Personal/Work
// /Development/Guest" framing.
interface ProfilesState {
  profiles: Profile[];
  activeProfile: Profile | null;
  isGuest: boolean;

  refresh: () => Promise<void>;
  create: (name: string) => Promise<void>;
  switchTo: (id: string) => Promise<void>;
  switchToGuest: () => void;
  remove: (id: string) => Promise<void>;
}

export const useProfilesStore = create<ProfilesState>((set, get) => ({
  profiles: [],
  activeProfile: null,
  isGuest: false,

  refresh: async () => {
    const [profiles, activeProfile] = await Promise.all([
      invoke<Profile[]>("list_profiles"),
      invoke<Profile>("current_profile"),
    ]);
    set({ profiles, activeProfile });
  },

  create: async (name) => {
    await invoke<Profile>("create_profile", { name });
    await get().refresh();
  },

  switchTo: async (id) => {
    await invoke("switch_profile", { id });
    set({ isGuest: false });
    await get().refresh();
  },

  switchToGuest: () => set({ isGuest: true }),

  remove: async (id) => {
    await invoke("delete_profile", { id });
    await get().refresh();
  },
}));
