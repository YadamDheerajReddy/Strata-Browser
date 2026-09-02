import { Plus, X } from "lucide-react";
import { useTabsStore } from "../stores/tabsStore";
import type { Tab } from "../types/tab";

// Pill-shaped tabs with the three quiet states from UI/UX Brief §4: normal
// (teal dot), active (elevated surface + accent ring), changed (amber dot —
// not wired up yet since it needs Continuum's background-update tracking
// from Phase 3, so every tab shows as normal or active for now).
function TabPill({ tab, isActive }: { tab: Tab; isActive: boolean }) {
  const setActiveTab = useTabsStore((s) => s.setActiveTab);
  const closeTab = useTabsStore((s) => s.closeTab);

  return (
    <button
      type="button"
      onClick={() => setActiveTab(tab.id)}
      className={`group relative flex h-8 max-w-52 min-w-32 shrink-0 items-center gap-2 rounded-lg px-3 text-sm transition-colors ${
        isActive
          ? "bg-[color:var(--color-surface-2)] text-[color:var(--color-text-primary)] ring-1 ring-[color:var(--color-accent)]/50"
          : "text-[color:var(--color-text-secondary)] hover:bg-[color:var(--color-surface-2)]/60"
      }`}
    >
      <span
        className={`h-1.5 w-1.5 shrink-0 rounded-full ${
          tab.isLoading
            ? "animate-pulse bg-[color:var(--color-text-secondary)]"
            : "bg-[color:var(--color-accent-2)]"
        }`}
      />
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
    </button>
  );
}

export function TabBar() {
  const tabs = useTabsStore((s) => s.tabs);
  const activeTabId = useTabsStore((s) => s.activeTabId);
  const addTab = useTabsStore((s) => s.addTab);

  return (
    <div
      data-tauri-drag-region
      className="flex h-11 items-center gap-1 border-b border-[color:var(--color-border)] bg-[color:var(--color-bg)] px-2"
    >
      <div className="flex flex-1 items-center gap-1 overflow-x-auto">
        {tabs.map((tab) => (
          <TabPill key={tab.id} tab={tab} isActive={tab.id === activeTabId} />
        ))}
      </div>
      <button
        type="button"
        aria-label="New tab"
        onClick={() => addTab()}
        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-[color:var(--color-text-secondary)] transition-colors hover:bg-[color:var(--color-surface-2)] hover:text-[color:var(--color-text-primary)]"
      >
        <Plus size={16} strokeWidth={1.75} />
      </button>
    </div>
  );
}
