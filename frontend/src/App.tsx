import { useEffect, useRef } from "react";
import { TabBar } from "./components/TabBar";
import { NavBar } from "./components/NavBar";
import { WindowControls } from "./components/WindowControls";
import { useTabsStore } from "./stores/tabsStore";

export default function App() {
  const activeTabId = useTabsStore((s) => s.activeTabId);
  const addTab = useTabsStore((s) => s.addTab);
  const refreshTabState = useTabsStore((s) => s.refreshTabState);

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
  // loading) from the CEF side — see tabsStore.refreshTabState for why this
  // is polling rather than push-based in Phase 1.
  useEffect(() => {
    if (!activeTabId) return;
    const interval = setInterval(() => void refreshTabState(activeTabId), 400);
    return () => clearInterval(interval);
  }, [activeTabId, refreshTabState]);

  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden bg-[color:var(--color-bg)]">
      <div
        data-tauri-drag-region
        className="flex h-8 shrink-0 items-center justify-between"
      >
        <div
          data-tauri-drag-region
          className="flex flex-1 items-center gap-2 pl-3"
        >
          <div className="h-4 w-4 rounded bg-gradient-to-br from-[color:var(--color-accent)] to-[color:var(--color-accent-2)]" />
          <span className="chrome-label">Strata</span>
        </div>
        <WindowControls />
      </div>

      <TabBar />
      <NavBar />

      {/* Content area: the actual webpage is rendered by CEF as a native
          child window layered directly over this region (see TRD §1) —
          React never draws page content itself. This placeholder exists so
          the layout/sizing is correct before that embedding is wired up. */}
      <div className="relative flex-1 bg-[color:var(--color-surface)]" />
    </div>
  );
}
