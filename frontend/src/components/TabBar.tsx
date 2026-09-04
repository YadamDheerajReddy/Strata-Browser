import { useEffect, useRef, useState } from "react";
import { Reorder } from "framer-motion";
import { Download, Globe, History, Loader2, Plus, Search, Snowflake, VenetianMask, X } from "lucide-react";
import { useTabsStore } from "../stores/tabsStore";
import { freezeTab } from "../lib/moments";
import type { Tab } from "../types/tab";

// Right-click menu on a tab pill — just Freeze Moment for now (App Flow doc
// §5). The UI/UX Brief's fuller list (Duplicate, Pin, Mute, Split, Save
// Moment, Close) waits on those features actually existing; a menu item
// that does nothing is worse than no menu item.
function TabContextMenu({ tab, onClose }: { tab: Tab; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onClickOutside = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener("mousedown", onClickOutside);
    return () => document.removeEventListener("mousedown", onClickOutside);
  }, [onClose]);

  const canFreeze = tab.kind === "web" && !tab.isPrivate;

  return (
    <div
      ref={ref}
      className="absolute left-0 top-9 z-30 w-44 rounded-lg border border-[color:var(--color-border)] bg-[color:var(--color-surface)] py-1.5 shadow-[0_12px_32px_-8px_rgba(0,0,0,0.5)]"
    >
      <button
        type="button"
        disabled={!canFreeze}
        onClick={() => {
          onClose();
          void freezeTab(tab.id);
        }}
        className="flex w-full items-center gap-2.5 px-3 py-1.5 text-left text-sm text-[color:var(--color-text-secondary)] hover:bg-[color:var(--color-surface-2)] hover:text-[color:var(--color-text-primary)] disabled:opacity-30 disabled:hover:bg-transparent"
      >
        <Snowflake size={13} strokeWidth={1.75} />
        Freeze Moment
      </button>
    </div>
  );
}

// Pill-shaped tabs with the three quiet states from UI/UX Brief §4: normal
// (favicon/globe), active (elevated surface + accent ring), changed (amber
// dot — not wired up yet since it needs Continuum's background-update
// tracking from Phase 3). Loading shows a small spinner in place of the
// favicon (UI/UX Brief §8: motion should confirm state, not decorate).
// History/Downloads/Home tabs get a fixed icon instead — they're not real
// pages, so there's no favicon or loading state to show. A private tab
// additionally gets a mask badge next to its icon (App Flow doc, Private
// Browsing) — the only per-tab signal that it won't be recorded.
function TabPill({ tab, isActive }: { tab: Tab; isActive: boolean }) {
  const setActiveTab = useTabsStore((s) => s.setActiveTab);
  const closeTab = useTabsStore((s) => s.closeTab);
  const [faviconFailed, setFaviconFailed] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);

  return (
    <Reorder.Item
      value={tab}
      as="button"
      type="button"
      initial={{ scale: 0.98, opacity: 0 }}
      animate={{ scale: 1, opacity: 1 }}
      whileDrag={{ scale: 1.04, zIndex: 1 }}
      transition={{ duration: 0.15 }}
      onClick={() => setActiveTab(tab.id)}
      onContextMenu={(e) => {
        e.preventDefault();
        setMenuOpen(true);
      }}
      className={`group relative flex h-8 max-w-52 min-w-32 shrink-0 items-center gap-2 rounded-lg px-3 text-sm transition-colors ${
        isActive
          ? "bg-[color:var(--color-surface-2)] text-[color:var(--color-text-primary)] ring-1 ring-[color:var(--color-accent)]/50"
          : "text-[color:var(--color-text-secondary)] hover:bg-[color:var(--color-surface-2)]/60"
      }`}
    >
      {tab.kind === "history" ? (
        <History size={13} strokeWidth={1.75} className="shrink-0 text-[color:var(--color-text-secondary)]" />
      ) : tab.kind === "downloads" ? (
        <Download size={13} strokeWidth={1.75} className="shrink-0 text-[color:var(--color-text-secondary)]" />
      ) : tab.kind === "home" ? (
        <Search size={13} strokeWidth={1.75} className="shrink-0 text-[color:var(--color-text-secondary)]" />
      ) : tab.isLoading ? (
        <Loader2
          size={13}
          strokeWidth={2}
          className="shrink-0 animate-spin text-[color:var(--color-text-secondary)]"
        />
      ) : tab.faviconUrl && !faviconFailed ? (
        <img
          src={tab.faviconUrl}
          alt=""
          className="h-3.5 w-3.5 shrink-0 rounded-sm"
          onError={() => setFaviconFailed(true)}
        />
      ) : (
        <Globe size={13} strokeWidth={1.75} className="shrink-0 text-[color:var(--color-text-secondary)]" />
      )}

      {tab.isPrivate && (
        <VenetianMask
          size={12}
          strokeWidth={1.75}
          className="shrink-0 text-[color:var(--color-accent)]"
        />
      )}

      <span className="flex-1 truncate text-left">{tab.title}</span>
      <span
        role="button"
        aria-label="Close tab"
        onClick={(e) => {
          e.stopPropagation();
          closeTab(tab.id);
        }}
        className="rounded p-0.5 opacity-0 transition-opacity group-hover:opacity-100 hover:bg-black/20"
      >
        <X size={12} strokeWidth={2} />
      </span>

      {menuOpen && <TabContextMenu tab={tab} onClose={() => setMenuOpen(false)} />}
    </Reorder.Item>
  );
}

export function TabBar() {
  const tabs = useTabsStore((s) => s.tabs);
  const activeTabId = useTabsStore((s) => s.activeTabId);
  const addTab = useTabsStore((s) => s.addTab);
  const setTabOrder = useTabsStore((s) => s.setTabOrder);

  return (
    <div
      data-tauri-drag-region
      className="flex h-11 items-center gap-1 border-b border-[color:var(--color-border)] bg-[color:var(--color-bg)] px-2"
    >
      {/* min-w-0 (not flex-1) so this only takes as much width as the tabs
          actually need — the "+" button sits right after the last tab
          instead of being pushed to the far right of the window, but this
          can still shrink and scroll internally once there are enough tabs
          to fill the available space. Reorder.Group drives drag-to-reorder
          via pointer events, not native HTML5/OS drag-and-drop — CEF's
          native child windows intercept the latter before it ever reaches
          the DOM (same issue that sank Split View's drag handles), so this
          sidesteps it entirely instead of needing dragDropEnabled:false. */}
      <Reorder.Group
        as="div"
        axis="x"
        values={tabs}
        onReorder={setTabOrder}
        layoutScroll
        className="flex min-w-0 items-center gap-1 overflow-x-auto"
      >
        {tabs.map((tab) => (
          <TabPill key={tab.id} tab={tab} isActive={tab.id === activeTabId} />
        ))}
      </Reorder.Group>
      <button
        type="button"
        aria-label="New tab"
        onClick={() => addTab()}
        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-[color:var(--color-text-secondary)] transition-colors hover:bg-[color:var(--color-surface-2)] hover:text-[color:var(--color-text-primary)]"
      >
        <Plus size={16} strokeWidth={1.75} />
      </button>
      <button
        type="button"
        aria-label="New private tab"
        title="New private tab (Ctrl+Shift+N)"
        onClick={() => addTab(undefined, true)}
        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-[color:var(--color-text-secondary)] transition-colors hover:bg-[color:var(--color-surface-2)] hover:text-[color:var(--color-text-primary)]"
      >
        <VenetianMask size={15} strokeWidth={1.75} />
      </button>
    </div>
  );
}
