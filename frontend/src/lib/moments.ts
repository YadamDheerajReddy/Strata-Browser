import { invoke } from "@tauri-apps/api/core";
import { useTabsStore } from "../stores/tabsStore";
import { useMomentsStore } from "../stores/momentsStore";
import type { MomentDetail } from "../stores/momentsStore";
import type { Tab } from "../types/tab";

interface TabSnapshot {
  tabId: string;
  url: string;
  title: string;
  faviconUrl: string | null;
  scrollX: number;
  scrollY: number;
}

// Reads a tab's *current* scroll position directly rather than trusting
// whatever tabsStore's throttled StateCollector checkpoint last wrote — the
// TRD is explicit that an explicit Save/Freeze bypasses that debounce
// window entirely, since the user is actively waiting on it.
async function snapshotTab(tab: Tab): Promise<TabSnapshot | null> {
  if (tab.kind !== "web" || tab.isPrivate || tab.browserId == null) return null;
  const state = await invoke<{ scrollX: number; scrollY: number } | null>("get_tab_state", {
    browserId: tab.browserId,
  });
  return {
    tabId: tab.id,
    url: tab.url,
    title: tab.title || tab.url,
    faviconUrl: tab.faviconUrl,
    scrollX: state?.scrollX ?? 0,
    scrollY: state?.scrollY ?? 0,
  };
}

// Save Current Moment (Ctrl+Shift+M / Continuum panel's button / command
// palette) — every open, non-private tab across the window becomes one
// named workspace snapshot (App Flow doc §6).
export async function saveCurrentMoment(name: string): Promise<void> {
  const tabs = useTabsStore.getState().tabs;
  const snapshots = (await Promise.all(tabs.map(snapshotTab))).filter(
    (s): s is TabSnapshot => s !== null,
  );
  if (snapshots.length === 0) {
    throw new Error("No open pages to save");
  }
  await invoke("save_moment", { name, tabs: snapshots });
  await useMomentsStore.getState().refresh();
}

// Freeze Moment (tab right-click / Ctrl+Shift+F) — one tab, auto-named,
// closed immediately after capture (App Flow doc §5: "I don't need this
// open right now, but I'm not done with it").
export async function freezeTab(tabId: string): Promise<void> {
  const tab = useTabsStore.getState().tabs.find((t) => t.id === tabId);
  if (!tab) return;
  const snapshot = await snapshotTab(tab);
  if (!snapshot) return;
  await invoke("freeze_tab", { tab: snapshot });
  await useMomentsStore.getState().refresh();
  await useTabsStore.getState().closeTab(tabId);
}

// Restore Moment (App Flow doc §8) — reopens every captured tab in
// original order, then reapplies each one's captured scroll position once
// it's finished loading. Split layout/window geometry restoration is
// explicitly Phase 5 (the schema's split_position exists but nothing
// produces a split to restore yet).
export async function restoreMoment(id: string): Promise<void> {
  const detail = await invoke<MomentDetail | null>("get_moment", { id });
  if (!detail) return;
  for (const tab of detail.tabs) {
    const tabId = await useTabsStore.getState().addTab(tab.url);
    void waitForLoadThenScroll(tabId, tab.scrollX, tab.scrollY);
  }
}

async function waitForLoadThenScroll(tabId: string, x: number, y: number): Promise<void> {
  if (x === 0 && y === 0) return;
  for (let attempt = 0; attempt < 20; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 300));
    const tab = useTabsStore.getState().tabs.find((t) => t.id === tabId);
    if (!tab || tab.browserId == null) return;
    if (!tab.isLoading) {
      await invoke("restore_scroll", { browserId: tab.browserId, x, y });
      return;
    }
  }
}
