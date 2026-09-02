import { useEffect, useState } from "react";
import { ArrowLeft, ArrowRight, Lock, RotateCw } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { useTabsStore } from "../stores/tabsStore";

// Back/forward/reload + the address bar — UI/UX Brief §4: "one field, no
// separate search box." The Rewind (Continuum) control that sits at the far
// right in the brief's mockup is intentionally left out until Phase 3;
// there is nothing for it to open yet.
export function NavBar() {
  const tabs = useTabsStore((s) => s.tabs);
  const activeTabId = useTabsStore((s) => s.activeTabId);
  const activeTab = tabs.find((t) => t.id === activeTabId);

  const [draft, setDraft] = useState(activeTab?.url ?? "");

  // Keep the address field in sync when the active tab changes (but not
  // while the user is mid-edit of the current tab's own URL).
  useEffect(() => {
    setDraft(activeTab?.url ?? "");
  }, [activeTab?.id, activeTab?.url]);

  const commitNavigation = () => {
    if (!activeTab || !draft.trim()) return;
    const url = normalizeUrl(draft.trim());
    invoke("navigate", { browserId: activeTab.browserId, url });
  };

  return (
    <div className="flex h-12 items-center gap-2 bg-[color:var(--color-bg)] px-3">
      <div className="flex items-center gap-0.5">
        <NavButton
          label="Back"
          disabled={!activeTab?.canGoBack}
          onClick={() => {
            if (activeTab) invoke("go_back", { browserId: activeTab.browserId });
          }}
        >
          <ArrowLeft size={16} strokeWidth={1.75} />
        </NavButton>
        <NavButton
          label="Forward"
          disabled={!activeTab?.canGoForward}
          onClick={() => {
            if (activeTab) invoke("go_forward", { browserId: activeTab.browserId });
          }}
        >
          <ArrowRight size={16} strokeWidth={1.75} />
        </NavButton>
        <NavButton
          label="Reload"
          onClick={() => {
            if (activeTab) invoke("reload_tab", { browserId: activeTab.browserId });
          }}
        >
          <RotateCw size={14} strokeWidth={1.75} />
        </NavButton>
      </div>

      <div className="flex h-8 flex-1 items-center gap-2 rounded-lg border border-[color:var(--color-border)] bg-[color:var(--color-surface)] px-3">
        <Lock
          size={13}
          strokeWidth={1.75}
          className="shrink-0 text-[color:var(--color-text-secondary)]"
        />
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") commitNavigation();
          }}
          placeholder="Search or enter address"
          className="flex-1 bg-transparent text-sm text-[color:var(--color-text-primary)] outline-none placeholder:text-[color:var(--color-text-secondary)]"
        />
      </div>
    </div>
  );
}

function NavButton({
  label,
  disabled,
  onClick,
  children,
}: {
  label: string;
  disabled?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className="flex h-7 w-7 items-center justify-center rounded-md text-[color:var(--color-text-secondary)] transition-colors hover:bg-[color:var(--color-surface-2)] hover:text-[color:var(--color-text-primary)] disabled:opacity-30 disabled:hover:bg-transparent"
    >
      {children}
    </button>
  );
}

function normalizeUrl(input: string): string {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(input)) return input;
  // Looks like a bare domain/path rather than a search query.
  if (/^[\w-]+(\.[\w-]+)+([/?#].*)?$/.test(input)) {
    return `https://${input}`;
  }
  return `https://www.google.com/search?q=${encodeURIComponent(input)}`;
}
