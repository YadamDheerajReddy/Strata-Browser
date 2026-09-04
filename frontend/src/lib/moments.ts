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
//
// Deliberately does NOT use addTab() in a loop: addTab() always switches to
// and reveals the tab it just created, which would flip away from the
// homepage (unmounting whatever "Restoring Moment..." UI lives there) and
// let the CEF browser it just revealed — a native window that always
// paints on top of this webview's own content — show through mid-batch,
// well before the whole Moment has finished restoring. Instead every tab
// is created hidden via addTabsForRestore, and only the last one is
// revealed, once RestoringMomentOverlay has fully finished its exit fade —
// see the sequencing below.
export async function restoreMoment(id: string): Promise<void> {
  const detail = await invoke<MomentDetail | null>("get_moment", { id });
  if (!detail || detail.tabs.length === 0) return;

  useMomentsStore.setState({
    restoring: { name: detail.name, tabs: detail.tabs.map((t) => t.title || t.url) },
  });

  const tabIds = await useTabsStore.getState().addTabsForRestore(detail.tabs.map((t) => t.url));

  // Keep "Restoring Moment..." on screen long enough to actually read (UI/
  // UX Brief §8's "brief... then a natural transition"), then give its
  // exit fade time to fully finish before revealing the restored tab.
  await sleep(700);
  useMomentsStore.setState({ restoring: null });
  await sleep(200);

  await useTabsStore.getState().setActiveTab(tabIds[tabIds.length - 1]);

  tabIds.forEach((tabId, i) => {
    void waitForLoadThenScroll(tabId, detail.tabs[i].scrollX, detail.tabs[i].scrollY);
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
