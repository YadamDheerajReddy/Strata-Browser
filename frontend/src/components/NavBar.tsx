import { useEffect, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  ArrowLeft,
  ArrowRight,
  Download,
  History,
  Lock,
  RotateCcw,
  RotateCw,
  Search,
  ShieldCheck,
  Star,
} from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { useTabsStore } from "../stores/tabsStore";
import { useBookmarksStore } from "../stores/bookmarksStore";
import type { HistoryEntry } from "../types/bookmark";

// Back/forward/reload + the address bar — UI/UX Brief §4: "one field, no
// separate search box." The ↶ Rewind button (UI/UX Brief §5) opens
// ContinuumPanel — a right-anchored timeline, not a tab — so it's rendered
// here rather than routed through tabsStore like History/Downloads.
export function NavBar() {
  const tabs = useTabsStore((s) => s.tabs);
  const activeTabId = useTabsStore((s) => s.activeTabId);
  const activeTab = tabs.find((t) => t.id === activeTabId);
  // No CEF browser behind any of these, so back/forward/reload never apply.
  const isInternal = activeTab != null && activeTab.kind !== "web";
  // History/Downloads render as a read-only label instead of the address
  // bar; Home keeps the normal editable bar (see commitNavigation) since
  // it's still a place you type a search/address into.
  const isReadOnlyPage = activeTab?.kind === "history" || activeTab?.kind === "downloads";

  const currentBookmark = useBookmarksStore((s) => s.currentBookmark);
  const checkCurrent = useBookmarksStore((s) => s.checkCurrent);
  const toggleBookmark = useBookmarksStore((s) => s.toggle);
  const navigateFromHome = useTabsStore((s) => s.navigateFromHome);

  const [draft, setDraft] = useState(activeTab?.url ?? "");
  const inputRef = useRef<HTMLInputElement>(null);

  // Keep the address field in sync when the active tab changes (but not
  // while the user is mid-edit of the current tab's own URL).
  useEffect(() => {
    setDraft(activeTab?.url ?? "");
  }, [activeTab?.id, activeTab?.url]);

  // Address-bar autocomplete, sourced from the same navigation_events log
  // History reads (see search_history in lib.rs) — never for a private tab,
  // matching the rest of the app's "no trace" rule for private browsing.
  const [suggestions, setSuggestions] = useState<HistoryEntry[]>([]);
  const [suggestionsOpen, setSuggestionsOpen] = useState(false);
  const [highlightedIndex, setHighlightedIndex] = useState(-1);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Gates the whole suggestion pipeline on the field actually being
  // focused — `draft` also changes on its own (the sync effect above,
  // driven by the tab-state poll) every time the page navigates, and
  // without this gate that alone was enough to search history for the
  // page's own URL, find its own visit, and pop the dropdown open with no
  // one typing anything.
  const [isFocused, setIsFocused] = useState(false);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    const query = draft.trim();
    if (!isFocused || !query || isReadOnlyPage || activeTab?.isPrivate) {
      setSuggestions([]);
      setSuggestionsOpen(false);
      return;
    }
    debounceRef.current = setTimeout(() => {
      invoke<HistoryEntry[]>("search_history", { query, limit: 6 }).then((results) => {
        setSuggestions(results);
        setSuggestionsOpen(results.length > 0);
        setHighlightedIndex(-1);
      });
    }, 120);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft, isFocused, isReadOnlyPage, activeTab?.isPrivate]);

  // The dropdown is chrome-webview content, but it can grow tall enough to
  // overlap the region where CEF's native browser child window sits — and
  // that native window always paints over the chrome webview regardless of
  // DOM z-index (same constraint Continuum/modals hit). Hiding the browser
  // and growing the webview to full-window (set_modal_open, already used
  // by SaveMomentDialog/CommandPalette for exactly this) is what actually
  // lets the dropdown render on top instead of underneath the page.
  useEffect(() => {
    invoke("set_modal_open", { open: suggestionsOpen });
    return () => {
      if (suggestionsOpen) void invoke("set_modal_open", { open: false });
    };
  }, [suggestionsOpen]);

  // Ctrl+L (App.tsx's global shortcut handler) focuses the address bar via
  // this event rather than a prop/ref threaded down from App — the two
  // components don't otherwise need to know about each other.
  useEffect(() => {
    const focusAndSelect = () => {
      inputRef.current?.focus();
      inputRef.current?.select();
    };
    window.addEventListener("strata:focus-address-bar", focusAndSelect);
    return () => window.removeEventListener("strata:focus-address-bar", focusAndSelect);
  }, []);

  // Keep the star's filled/outline state matching the active tab's actual
  // URL (not the draft — a half-typed address bar shouldn't flip the star).
  useEffect(() => {
    if (activeTab?.kind === "web" && activeTab.url) void checkCurrent(activeTab.url);
  }, [activeTab?.kind, activeTab?.url, checkCurrent]);

  const navigateTo = (url: string) => {
    if (!activeTab) return;
    if (activeTab.kind === "web" && activeTab.browserId != null) {
      invoke("navigate", { browserId: activeTab.browserId, url });
    } else if (activeTab.kind === "home") {
      void navigateFromHome(activeTab.id, url);
    }
  };

  const commitNavigation = (opts?: { forceCom?: boolean }) => {
    if (!activeTab || !draft.trim()) return;
    const url = opts?.forceCom ? completeDotCom(draft.trim()) : normalizeUrl(draft.trim());
    navigateTo(url);
  };

  const selectSuggestion = (entry: HistoryEntry) => {
    setDraft(entry.url);
    setSuggestionsOpen(false);
    navigateTo(entry.url);
  };

  return (
    <div className="relative flex h-12 items-center gap-2 bg-[color:var(--color-bg)] px-3">
      <AnimatePresence>
        {activeTab?.isLoading && (
          <motion.div
            key="loading-bar"
            className="absolute bottom-0 left-0 h-0.5 bg-[color:var(--color-accent)]"
            initial={{ width: "0%", opacity: 1 }}
            animate={{ width: ["0%", "75%", "92%"], opacity: 1 }}
            exit={{ width: "100%", opacity: 0, transition: { duration: 0.2 } }}
            transition={{ duration: 1.4, ease: "easeOut" }}
          />
        )}
      </AnimatePresence>

      <div className="flex items-center gap-0.5">
        <NavButton
          label="Back"
          disabled={isInternal || !activeTab?.canGoBack}
          onClick={() => {
            if (activeTab?.kind === "web") invoke("go_back", { browserId: activeTab.browserId });
          }}
        >
          <ArrowLeft size={16} strokeWidth={1.75} />
        </NavButton>
        <NavButton
          label="Forward"
          disabled={isInternal || !activeTab?.canGoForward}
          onClick={() => {
            if (activeTab?.kind === "web") invoke("go_forward", { browserId: activeTab.browserId });
          }}
        >
          <ArrowRight size={16} strokeWidth={1.75} />
        </NavButton>
        <NavButton
          label="Reload"
          disabled={isInternal}
          onClick={() => {
            if (activeTab?.kind === "web") invoke("reload_tab", { browserId: activeTab.browserId });
          }}
        >
          <RotateCw size={14} strokeWidth={1.75} />
        </NavButton>
      </div>

      {isReadOnlyPage ? (
        <div className="flex h-8 flex-1 items-center gap-2 rounded-lg border border-[color:var(--color-border)] bg-[color:var(--color-surface)] px-3 text-sm text-[color:var(--color-text-secondary)]">
          {activeTab.kind === "history" ? (
            <History size={13} strokeWidth={1.75} className="shrink-0" />
          ) : (
            <Download size={13} strokeWidth={1.75} className="shrink-0" />
          )}
          <span>{activeTab.title}</span>
        </div>
      ) : (
        <div className="relative flex-1">
          <div className="flex h-8 items-center gap-2 rounded-lg border border-[color:var(--color-border)] bg-[color:var(--color-surface)] px-3">
            {activeTab?.kind === "home" ? (
              <Search
                size={13}
                strokeWidth={1.75}
                className="shrink-0 text-[color:var(--color-text-secondary)]"
              />
            ) : (
              <Lock
                size={13}
                strokeWidth={1.75}
                className="shrink-0 text-[color:var(--color-text-secondary)]"
              />
            )}
            <input
              ref={inputRef}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onFocus={() => {
                setIsFocused(true);
                if (suggestions.length > 0) setSuggestionsOpen(true);
              }}
              onBlur={() => {
                // Let a suggestion row's onMouseDown (below) fire and commit
                // navigation before the dropdown disappears out from under it.
                setTimeout(() => {
                  setIsFocused(false);
                  setSuggestionsOpen(false);
                }, 100);
              }}
              onKeyDown={(e) => {
                if (e.key === "ArrowDown" && suggestionsOpen) {
                  e.preventDefault();
                  setHighlightedIndex((i) => Math.min(i + 1, suggestions.length - 1));
                } else if (e.key === "ArrowUp" && suggestionsOpen) {
                  e.preventDefault();
                  setHighlightedIndex((i) => Math.max(i - 1, -1));
                } else if (e.key === "Escape" && suggestionsOpen) {
                  setSuggestionsOpen(false);
                } else if (e.key === "Enter") {
                  e.preventDefault();
                  if (suggestionsOpen && highlightedIndex >= 0) {
                    selectSuggestion(suggestions[highlightedIndex]);
                  } else {
                    // Ctrl+Enter (like every other browser): "example" -> https://www.example.com
                    commitNavigation({ forceCom: e.ctrlKey || e.metaKey });
                    setSuggestionsOpen(false);
                  }
                }
              }}
              placeholder="Search or enter address"
              className="flex-1 bg-transparent text-sm text-[color:var(--color-text-primary)] outline-none placeholder:text-[color:var(--color-text-secondary)]"
            />
            {activeTab?.isPrivate && (
              <span className="flex shrink-0 items-center gap-1 rounded-full bg-[color:var(--color-accent)]/15 px-2 py-0.5 text-[10px] font-medium text-[color:var(--color-accent)]">
                <ShieldCheck size={11} strokeWidth={2} />
                Safe Browsing
              </span>
            )}
            <button
              type="button"
              aria-label={currentBookmark ? "Remove bookmark" : "Bookmark this page"}
              disabled={!activeTab?.url}
              onClick={() => {
                if (activeTab?.url) void toggleBookmark(activeTab.url, activeTab.title, activeTab.faviconUrl);
              }}
              className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-[color:var(--color-text-secondary)] hover:text-[color:var(--color-text-primary)] disabled:opacity-30"
            >
              <Star
                size={14}
                strokeWidth={1.75}
                fill={currentBookmark ? "currentColor" : "none"}
                className={currentBookmark ? "text-[color:var(--color-accent)]" : undefined}
              />
            </button>
          </div>

          {suggestionsOpen && suggestions.length > 0 && (
            <div className="absolute left-0 right-0 top-[calc(100%+4px)] z-30 overflow-hidden rounded-lg border border-[color:var(--color-border)] bg-[color:var(--color-surface)] shadow-[0_12px_32px_-8px_rgba(0,0,0,0.5)]">
              {suggestions.map((entry, i) => (
                <button
                  key={entry.id}
                  type="button"
                  onMouseDown={(e) => {
                    // Fires before the input's onBlur — keeps the click from
                    // being swallowed by the dropdown closing first.
                    e.preventDefault();
                    selectSuggestion(entry);
                  }}
                  onMouseEnter={() => setHighlightedIndex(i)}
                  className={`flex w-full items-center gap-2.5 px-3 py-2 text-left ${
                    i === highlightedIndex
                      ? "bg-[color:var(--color-surface-2)]"
                      : ""
                  }`}
                >
                  <Search size={12} strokeWidth={1.75} className="shrink-0 text-[color:var(--color-text-secondary)]" />
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate text-sm text-[color:var(--color-text-primary)]">
                      {entry.title || entry.url}
                    </span>
                    <span className="truncate text-xs text-[color:var(--color-text-secondary)]">
                      {entry.url}
                    </span>
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      <NavButton
        label="Open Continuum (Ctrl+Shift+R)"
        onClick={() => window.dispatchEvent(new CustomEvent("strata:toggle-continuum"))}
      >
        <RotateCcw size={14} strokeWidth={1.75} />
      </NavButton>
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

// Ctrl+Enter (every other browser's shortcut for "finish this domain"):
// "example" -> https://www.example.com. Strips any existing www./.com first
// so it stays idempotent instead of piling up (www.www.example.com.com).
function completeDotCom(input: string): string {
  let value = input.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "").replace(/\/+$/, "");
  value = value.replace(/^www\./i, "").replace(/\.com$/i, "");
  return `https://www.${value}.com`;
}

function normalizeUrl(input: string): string {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(input)) return input;
  // Looks like a bare domain/path rather than a search query.
  if (/^[\w-]+(\.[\w-]+)+([/?#].*)?$/.test(input)) {
    return `https://${input}`;
  }
  return `https://www.google.com/search?q=${encodeURIComponent(input)}`;
}
