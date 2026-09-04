import { useEffect, useRef, useState, type CSSProperties } from "react";
import { motion } from "framer-motion";
import { invoke } from "@tauri-apps/api/core";
import { ArrowRight, Globe, Pencil, Search, X } from "lucide-react";
import type { HistoryEntry } from "../types/bookmark";
import { useTabsStore } from "../stores/tabsStore";
import { useMomentsStore, type Moment } from "../stores/momentsStore";
import { restoreMoment } from "../lib/moments";
import { Logo } from "./Logo";

function relativeTime(unixSeconds: number): string {
  const seconds = Math.max(0, Math.floor(Date.now() / 1000) - unixSeconds);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hr ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days} day${days === 1 ? "" : "s"} ago`;
  return `${Math.floor(days / 7)} week${Math.floor(days / 7) === 1 ? "" : "s"} ago`;
}

function greeting(): string {
  const hour = new Date().getHours();
  if (hour < 5) return "Still up";
  if (hour < 12) return "Good morning";
  if (hour < 18) return "Good afternoon";
  return "Good evening";
}

function normalizeUrl(input: string): string {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(input)) return input;
  if (/^[\w-]+(\.[\w-]+)+([/?#].*)?$/.test(input)) {
    return `https://${input}`;
  }
  return `https://www.google.com/search?q=${encodeURIComponent(input)}`;
}

const WORDMARK = "STRATA".split("");

// Strata's own new-tab page (UI/UX Brief §7) — a search box plus a real
// look at recent activity. Given its own room to be a *destination* rather
// than quiet chrome (unlike the rest of the brief's "motion confirms state,
// not decoration" restraint — the tab bar and nav bar stay quiet, this page
// is the one place meant to feel premium at a glance). "Continue" is backed
// by real history; "Moments" (Implementation Plan Phase 4) is backed by
// real saved/frozen workspaces — both omitted entirely rather than shown
// empty when there's nothing yet (App Flow doc §2).
export function HomePage({ tabId, isPrivate }: { tabId: string; isPrivate: boolean }) {
  const navigateFromHome = useTabsStore((s) => s.navigateFromHome);
  const moments = useMomentsStore((s) => s.moments);
  const refreshMoments = useMomentsStore((s) => s.refresh);
  const removeMoment = useMomentsStore((s) => s.remove);
  const renameMoment = useMomentsStore((s) => s.rename);
  const [query, setQuery] = useState("");
  const [recent, setRecent] = useState<HistoryEntry[]>([]);
  const [focused, setFocused] = useState(false);
  const [glow, setGlow] = useState({ x: 50, y: 50 });
  const [glowVisible, setGlowVisible] = useState(false);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    // A private tab's home page shows no "Continue"/"Moments" — real
    // browsing context has no business appearing on a page whose whole
    // point is not leaving one (see tabsStore's makeHomeTab).
    if (!isPrivate) {
      invoke<HistoryEntry[]>("list_history", { limit: 4 }).then(setRecent);
      void refreshMoments();
    }
    inputRef.current?.focus();
  }, [isPrivate, refreshMoments]);

  const startRename = (moment: Moment) => {
    setRenamingId(moment.id);
    setRenameValue(moment.name);
  };

  const commitRename = async () => {
    if (renamingId && renameValue.trim()) {
      await renameMoment(renamingId, renameValue.trim());
    }
    setRenamingId(null);
  };

  const submit = () => {
    if (!query.trim()) return;
    void navigateFromHome(tabId, normalizeUrl(query.trim()));
  };

  return (
    <div className="absolute inset-0 overflow-y-auto">
      {/* Aurora backdrop — three slow-drifting blurred blobs in the brand
          colors, purely decorative and fixed to the viewport so scrolling
          the Continue grid doesn't drag them along. */}
      <div className="pointer-events-none fixed inset-0 overflow-hidden">
        <div className="aurora-blob aurora-blob-1" />
        <div className="aurora-blob aurora-blob-2" />
        <div className="aurora-blob aurora-blob-3" />
      </div>

      <div className="relative mx-auto flex max-w-3xl flex-col items-center px-8 py-24">
        <motion.p
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5 }}
          className="mb-3 text-sm text-[color:var(--color-text-secondary)]"
        >
          {greeting()}
        </motion.p>

        <motion.div
          initial={{ opacity: 0, scale: 0.8 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ duration: 0.4 }}
          className="mb-3"
        >
          <Logo size={36} />
        </motion.div>

        <div className="mb-2 flex font-[family-name:var(--font-wordmark)] text-4xl tracking-[0.15em]">
          {WORDMARK.map((letter, i) => (
            <motion.span
              key={i}
              initial={{ opacity: 0, y: 16 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.5, delay: i * 0.05, ease: "easeOut" }}
              className="bg-gradient-to-br from-[color:var(--color-accent)] to-[color:var(--color-accent-2)] bg-clip-text text-transparent drop-shadow-[0_0_24px_rgba(139,124,255,0.25)]"
            >
              {letter}
            </motion.span>
          ))}
        </div>
        <motion.p
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.6, delay: 0.35 }}
          className="mb-10 text-sm text-[color:var(--color-text-secondary)]"
        >
          Browse in context.
        </motion.p>

        <motion.div
          initial={{ opacity: 0, y: 10, scale: 0.98 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          transition={{ duration: 0.45, delay: 0.45 }}
          onMouseMove={(e) => {
            const rect = e.currentTarget.getBoundingClientRect();
            setGlow({
              x: ((e.clientX - rect.left) / rect.width) * 100,
              y: ((e.clientY - rect.top) / rect.height) * 100,
            });
          }}
          onMouseEnter={() => setGlowVisible(true)}
          onMouseLeave={() => setGlowVisible(false)}
          style={{ "--glow-x": `${glow.x}%`, "--glow-y": `${glow.y}%` } as CSSProperties}
          className={`relative mb-14 flex w-full items-center gap-3 overflow-hidden rounded-full border bg-[color:var(--color-surface)]/80 px-5 py-3.5 backdrop-blur-xl transition-shadow ${
            focused
              ? "border-[color:var(--color-accent)] shadow-[0_0_0_4px_rgba(139,124,255,0.12),0_8px_40px_-8px_rgba(139,124,255,0.35)]"
              : "border-[color:var(--color-accent)]/30 shadow-[0_8px_30px_-12px_rgba(0,0,0,0.5)]"
          }`}
        >
          {/* Glow spot that tracks the cursor across the bar — purely
              decorative, hence pointer-events-none and behind the real
              controls (z-10 on the wrapper below). */}
          <div
            className="pointer-events-none absolute inset-0 transition-opacity duration-300"
            style={{
              opacity: glowVisible ? 1 : 0,
              background:
                "radial-gradient(220px circle at var(--glow-x) var(--glow-y), rgba(139,124,255,0.4), transparent 70%)",
            }}
          />
          <Search
            size={18}
            strokeWidth={1.75}
            className="relative z-10 shrink-0 text-[color:var(--color-text-secondary)]"
          />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            onKeyDown={(e) => {
              if (e.key === "Enter") submit();
            }}
            placeholder="Search or enter address"
            className="relative z-10 flex-1 bg-transparent text-[15px] text-[color:var(--color-text-primary)] outline-none placeholder:text-[color:var(--color-text-secondary)]"
          />
          <button
            type="button"
            aria-label="Go"
            onClick={submit}
            disabled={!query.trim()}
            className="relative z-10 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-[color:var(--color-accent)] to-[color:var(--color-accent-2)] text-white transition-opacity disabled:opacity-20"
          >
            <ArrowRight size={16} strokeWidth={2} />
          </button>
        </motion.div>

        {recent.length > 0 && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.4, delay: 0.6 }}
            className="w-full"
          >
            <div className="mb-3 flex items-center justify-between">
              <span className="chrome-label">Continue</span>
              <button
                type="button"
                onClick={() => useTabsStore.getState().openInternalTab("history")}
                className="text-xs text-[color:var(--color-accent)] hover:underline"
              >
                View all
              </button>
            </div>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              {recent.map((entry, i) => (
                <motion.button
                  key={entry.id}
                  type="button"
                  initial={{ opacity: 0, y: 12 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.35, delay: 0.65 + i * 0.06 }}
                  whileHover={{ y: -3 }}
                  onClick={() => void navigateFromHome(tabId, entry.url)}
                  className="group relative flex flex-col gap-2.5 overflow-hidden rounded-xl border border-[color:var(--color-border)] bg-[color:var(--color-surface)]/90 p-3 text-left backdrop-blur-sm transition-colors hover:border-[color:var(--color-accent)]/40 hover:bg-[color:var(--color-surface-2)]"
                >
                  <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-[color:var(--color-surface-2)]">
                    {entry.faviconUrl ? (
                      <img src={entry.faviconUrl} alt="" className="h-4 w-4 rounded-sm" />
                    ) : (
                      <Globe size={15} strokeWidth={1.75} className="text-[color:var(--color-text-secondary)]" />
                    )}
                  </div>
                  <div className="min-w-0">
                    <p className="truncate text-sm text-[color:var(--color-text-primary)]">{entry.title}</p>
                    <p className="truncate text-xs text-[color:var(--color-text-secondary)]">
                      {relativeTime(entry.timestamp)}
                    </p>
                  </div>
                  <span className="pointer-events-none absolute inset-x-0 bottom-0 h-0.5 bg-gradient-to-r from-[color:var(--color-accent)] to-[color:var(--color-accent-2)] opacity-0 transition-opacity group-hover:opacity-100" />
                </motion.button>
              ))}
            </div>
          </motion.div>
        )}

        {moments.length > 0 && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.4, delay: 0.7 }}
            className="mt-8 w-full"
          >
            <span className="chrome-label mb-3 block">Moments</span>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              {moments.map((moment, i) => (
                <motion.div
                  key={moment.id}
                  initial={{ opacity: 0, y: 12 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.35, delay: 0.75 + i * 0.06 }}
                  whileHover={{ y: -3 }}
                  className="group relative flex flex-col gap-2.5 overflow-hidden rounded-xl border border-[color:var(--color-border)] bg-[color:var(--color-surface)]/90 p-3 text-left backdrop-blur-sm transition-colors hover:border-[color:var(--color-accent-2)]/40 hover:bg-[color:var(--color-surface-2)]"
                >
                  <button
                    type="button"
                    onClick={() => void restoreMoment(moment.id)}
                    className="flex flex-col gap-2.5 text-left"
                  >
                    <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-[color:var(--color-surface-2)]">
                      {moment.tabs[0]?.faviconUrl ? (
                        <img src={moment.tabs[0].faviconUrl} alt="" className="h-4 w-4 rounded-sm" />
                      ) : (
                        <Globe size={15} strokeWidth={1.75} className="text-[color:var(--color-text-secondary)]" />
                      )}
                    </div>
                    <div className="min-w-0">
                      {renamingId === moment.id ? (
                        <input
                          autoFocus
                          value={renameValue}
                          onClick={(e) => e.stopPropagation()}
                          onChange={(e) => setRenameValue(e.target.value)}
                          onBlur={() => void commitRename()}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") void commitRename();
                            if (e.key === "Escape") setRenamingId(null);
                          }}
                          className="w-full truncate rounded border border-[color:var(--color-accent)] bg-[color:var(--color-bg)] px-1 text-sm text-[color:var(--color-text-primary)] outline-none"
                        />
                      ) : (
                        <p className="truncate text-sm text-[color:var(--color-text-primary)]">{moment.name}</p>
                      )}
                      <p className="truncate text-xs text-[color:var(--color-text-secondary)]">
                        {moment.tabCount} tab{moment.tabCount === 1 ? "" : "s"} · {relativeTime(moment.updatedAt)}
                      </p>
                    </div>
                  </button>
                  <div className="absolute right-1.5 top-1.5 flex gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
                    <button
                      type="button"
                      aria-label="Rename Moment"
                      onClick={(e) => {
                        e.stopPropagation();
                        startRename(moment);
                      }}
                      className="rounded p-1 text-[color:var(--color-text-secondary)] hover:bg-black/20 hover:text-[color:var(--color-text-primary)]"
                    >
                      <Pencil size={11} strokeWidth={1.75} />
                    </button>
                    <button
                      type="button"
                      aria-label="Delete Moment"
                      onClick={(e) => {
                        e.stopPropagation();
                        void removeMoment(moment.id);
                      }}
                      className="rounded p-1 text-[color:var(--color-text-secondary)] hover:bg-black/20 hover:text-[color:var(--color-text-primary)]"
                    >
                      <X size={11} strokeWidth={1.75} />
                    </button>
                  </div>
                  <span className="pointer-events-none absolute inset-x-0 bottom-0 h-0.5 bg-gradient-to-r from-[color:var(--color-accent-2)] to-[color:var(--color-accent)] opacity-0 transition-opacity group-hover:opacity-100" />
                </motion.div>
              ))}
            </div>
          </motion.div>
        )}
      </div>
    </div>
  );
}
