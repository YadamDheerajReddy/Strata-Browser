import { useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { TabBar } from "./components/TabBar";
import { NavBar } from "./components/NavBar";
import { WindowControls } from "./components/WindowControls";
import { HistoryPanel } from "./components/HistoryPanel";
import { DownloadsPanel } from "./components/DownloadsPanel";
import { HomePage } from "./components/HomePage";
import { BookmarksBar } from "./components/BookmarksBar";
import { Logo } from "./components/Logo";
import { PermissionPrompt } from "./components/PermissionPrompt";
import { ProfileSwitcher } from "./components/ProfileSwitcher";
import { ContinuumPanel } from "./components/ContinuumPanel";
import { SaveMomentDialog } from "./components/SaveMomentDialog";
import { RestoringMomentOverlay } from "./components/RestoringMomentOverlay";
import { CommandPalette } from "./components/CommandPalette";
import { CrashedPagePanel } from "./components/CrashedPagePanel";
import { useTabsStore } from "./stores/tabsStore";
import { useBookmarksStore } from "./stores/bookmarksStore";
import { freezeTab } from "./lib/moments";
import type { Action } from "./types/action";

// handleAction below is where every one of Action's variants is handled —
// shared between the DOM keydown handler (fires when the chrome webview
// has focus), the "shortcut" Tauri event (CEF forwarding one from a page
// that has keyboard focus; see strata_client.cpp's OnPreKeyEvent and
// cef_bridge.rs's set_shortcut_forwarding), and CommandPalette's
// "strata:action" event.

export default function App() {
  const tabs = useTabsStore((s) => s.tabs);
  const activeTabId = useTabsStore((s) => s.activeTabId);
  const activeTab = tabs.find((t) => t.id === activeTabId);
  const addTab = useTabsStore((s) => s.addTab);
  const openInternalTab = useTabsStore((s) => s.openInternalTab);
  const closeTab = useTabsStore((s) => s.closeTab);
  const setActiveTab = useTabsStore((s) => s.setActiveTab);
  const refreshTabState = useTabsStore((s) => s.refreshTabState);
  const markCrashed = useTabsStore((s) => s.markCrashed);
  const toggleBookmark = useBookmarksStore((s) => s.toggle);

  // First launch: land on a single tab (App Flow doc §2 — no account, no
  // setup, straight to browsing). Guarded with a ref rather than
  // `tabs.length === 0`: addTab() is async (it awaits a real CEF browser
  // creation), and React StrictMode's dev-mode double-invoke of effects was
  // firing this twice before the first call's tab landed in the store,
  // creating two overlapping browsers on the same window region.
  const didInit = useRef(false);
  useEffect(() => {
    if (didInit.current) return;
    didInit.current = true;
    void addTab();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Poll the active tab's real navigation state (title/url/back/forward/
  // loading/favicon) from the CEF side — see tabsStore.refreshTabState for
  // why this is polling rather than push-based in Phase 1/2. A no-op for
  // History/Downloads tabs, which have no CEF browser behind them.
  useEffect(() => {
    if (!activeTabId) return;
    const interval = setInterval(() => void refreshTabState(activeTabId), 400);
    return () => clearInterval(interval);
  }, [activeTabId, refreshTabState]);

  // Keep the latest tabs/activeTabId available to the two listeners below
  // without having to re-subscribe them on every tab change.
  const latest = useRef({ tabs, activeTabId });
  latest.current = { tabs, activeTabId };

  const handleAction = (action: Action) => {
    const { tabs, activeTabId } = latest.current;
    const activeTab = tabs.find((t) => t.id === activeTabId);

    switch (action) {
      case "new_tab":
        void addTab();
        break;
      case "new_private_tab":
        void addTab(undefined, true);
        break;
      case "close_tab":
        if (activeTabId) void closeTab(activeTabId);
        break;
      case "focus_address_bar":
        window.dispatchEvent(new CustomEvent("strata:focus-address-bar"));
        break;
      case "reload":
        if (activeTab?.kind === "web" && activeTab.browserId != null) {
          invoke("reload_tab", { browserId: activeTab.browserId });
        }
        break;
      case "bookmark":
        if (activeTab?.kind === "web")
          void toggleBookmark(activeTab.url, activeTab.title, activeTab.faviconUrl);
        break;
      case "history":
        void openInternalTab("history");
        break;
      case "downloads":
        void openInternalTab("downloads");
        break;
      case "next_tab": {
        if (tabs.length < 2) break;
        const index = tabs.findIndex((t) => t.id === activeTabId);
        const next = tabs[(index + 1) % tabs.length];
        void setActiveTab(next.id);
        break;
      }
      case "open_continuum":
        window.dispatchEvent(new CustomEvent("strata:toggle-continuum"));
        break;
      case "save_moment":
        window.dispatchEvent(new CustomEvent("strata:save-moment"));
        break;
      case "freeze_moment":
        if (activeTab) void freezeTab(activeTab.id);
        break;
      case "open_command_palette":
        window.dispatchEvent(new CustomEvent("strata:open-command-palette"));
        break;
    }
  };

  // Path 1: chrome (React webview) has keyboard focus.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      const key = e.key.toLowerCase();
      const action: Action | null =
        e.shiftKey && key === "n"
          ? "new_private_tab"
          : e.shiftKey && key === "r"
            ? "open_continuum"
            : e.shiftKey && key === "m"
              ? "save_moment"
              : e.shiftKey && key === "f"
                ? "freeze_moment"
                : e.shiftKey
                  ? null
                  : key === "t"
              ? "new_tab"
              : key === "w"
                ? "close_tab"
                : key === "l"
                  ? "focus_address_bar"
                  : key === "r"
                    ? "reload"
                    : key === "d"
                      ? "bookmark"
                      : key === "h"
                        ? "history"
                        : key === "j"
                          ? "downloads"
                          : key === "tab"
                            ? "next_tab"
                            : key === "k"
                              ? "open_command_palette"
                              : null;
      if (action) {
        e.preventDefault();
        handleAction(action);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Path 2: a page (CEF content) has keyboard focus — the chrome webview
  // never sees the keydown at all in that case, so CEF forwards it here.
  useEffect(() => {
    const unlisten = listen<string>("shortcut", (event) => {
      handleAction(event.payload as Action);
    });
    return () => {
      void unlisten.then((f) => f());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // CommandPalette selections land here rather than calling handleAction
  // directly — it has no access to this closure, and dispatching an event
  // (same pattern as every other cross-component trigger in this file:
  // focus-address-bar, toggle-continuum, save-moment) keeps it decoupled.
  useEffect(() => {
    const onAction = (e: Event) => handleAction((e as CustomEvent<Action>).detail);
    window.addEventListener("strata:action", onAction);
    return () => window.removeEventListener("strata:action", onAction);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // A link that tried to open a new tab/window (target="_blank",
  // window.open(), "open in new tab/window" from the page's own context
  // menu) lands here — CEF cancels its own default popup unconditionally
  // (see strata_client.cpp's OnBeforePopup) and forwards the URL instead,
  // so opening it as a real Strata tab is this app's job, not CEF's.
  useEffect(() => {
    const unlisten = listen<string>("open-tab", (event) => {
      void addTab(event.payload);
    });
    return () => {
      void unlisten.then((f) => f());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // A tab's renderer process crashed/was killed/ran out of memory
  // (Implementation Plan Phase 6's crash recovery — see cef_bridge.rs's
  // CrashEvent and strata_client.cpp's OnRenderProcessTerminated).
  useEffect(() => {
    const unlisten = listen<{ browserId: number; reason: string }>("tab-crashed", (event) => {
      void markCrashed(event.payload.browserId, event.payload.reason);
    });
    return () => {
      void unlisten.then((f) => f());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // A page entered/exited HTML5 fullscreen (a video site's own fullscreen
  // button, etc. — see strata_client.cpp's OnFullscreenModeChange). The
  // actual visual effect (covering the whole window, hiding the tab/nav/
  // bookmarks bars) happens natively once set_browser_fullscreen resizes
  // the browser; nothing here needs to touch React's own layout.
  useEffect(() => {
    const unlisten = listen<{ browserId: number; fullscreen: boolean }>(
      "browser-fullscreen",
      (event) => {
        void invoke("set_browser_fullscreen", {
          browserId: event.payload.browserId,
          fullscreen: event.payload.fullscreen,
        });
      }
    );
    return () => {
      void unlisten.then((f) => f());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Clicking a history entry opens it in a fresh tab and puts the History
  // page away — there's no CEF browser behind the History tab itself to
  // navigate.
  const navigateFromPanel = async (url: string) => {
    const historyTabId = activeTabId;
    await addTab(url);
    if (historyTabId) await closeTab(historyTabId);
  };

  return (
    <div className="relative flex h-screen w-screen flex-col overflow-hidden bg-[color:var(--color-bg)]">
      <PermissionPrompt />
      <ContinuumPanel />
      <SaveMomentDialog />
      <RestoringMomentOverlay />
      <CommandPalette />

      <div
        data-tauri-drag-region
        className="flex h-8 shrink-0 items-center justify-between"
      >
        <div
          data-tauri-drag-region
          className="flex flex-1 items-center gap-2 pl-3"
        >
          <Logo size={16} />
          <span className="chrome-label">Strata</span>
        </div>
        <div className="flex items-center pr-2">
          <ProfileSwitcher />
        </div>
        <WindowControls />
      </div>

      <TabBar />
      <NavBar />
      <BookmarksBar />

      {/* Content area: the actual webpage is rendered by CEF as a native
          child window layered directly over this region (see TRD §1) —
          React never draws page content itself. When the active tab is an
          internal page (History/Downloads) or the CEF browser is hidden,
          the Rust side grows this webview to cover the whole window instead
          (see set_panel_open), so this becomes real usable space rather
          than a placeholder. */}
      <div className="relative flex-1 bg-[color:var(--color-surface)]">
        {activeTab?.kind === "home" && <HomePage tabId={activeTab.id} isPrivate={activeTab.isPrivate} />}
        {activeTab?.kind === "history" && <HistoryPanel onNavigate={navigateFromPanel} />}
        {activeTab?.kind === "downloads" && <DownloadsPanel />}
        {activeTab?.kind === "web" && activeTab.crashed && (
          <CrashedPagePanel tab={activeTab} reason={activeTab.crashReason} />
        )}
      </div>
    </div>
  );
}
