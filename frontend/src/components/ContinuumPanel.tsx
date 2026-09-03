import { useEffect, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { invoke } from "@tauri-apps/api/core";
import { X } from "lucide-react";
import type { HistoryEntry } from "../types/bookmark";
import { useTabsStore } from "../stores/tabsStore";

function dayLabel(unixSeconds: number): string {
  const date = new Date(unixSeconds * 1000);
  const today = new Date();
  const yesterday = new Date();
  yesterday.setDate(today.getDate() - 1);
  const sameDay = (a: Date, b: Date) =>
    a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  if (sameDay(date, today)) return "TODAY";
  if (sameDay(date, yesterday)) return "YESTERDAY";
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" }).toUpperCase();
}

function timeLabel(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

// TimelineManager's read side (TRD §4, ContinuumManager) — grouped-by-day
// view over the same navigation_events data History reads (App Flow doc
// §7: "Rewind reads from navigation_events... it's the raw, chronological
// record"), so there's no separate backend query to duplicate. Save/Freeze
// Moment intentionally aren't here yet — Implementation Plan Phase 3's
// exit criterion is this panel becoming usable "even before Moments
// exist"; that's Phase 4.
export function ContinuumPanel() {
  const [open, setOpen] = useState(false);
  const [entries, setEntries] = useState<HistoryEntry[]>([]);
  const addTab = useTabsStore((s) => s.addTab);

  useEffect(() => {
    const toggle = () => setOpen((v) => !v);
    window.addEventListener("strata:toggle-continuum", toggle);
    return () => window.removeEventListener("strata:toggle-continuum", toggle);
  }, []);

  useEffect(() => {
    if (!open) return;
    invoke<HistoryEntry[]>("list_history", { limit: 50 }).then(setEntries);
  }, [open]);

  // The CEF browser behind the active tab is a native child window that
  // always paints on top of this webview's own content — plain CSS
  // z-index can't put a React panel above it. set_continuum_open narrows
  // the browser to leave this panel's column empty instead, so it renders
  // as a true full-height sidebar rather than being clipped to whatever
  // strip the chrome webview normally occupies. Width must match the
  // w-[400px] below (see lib.rs's SIDEBAR_WIDTH_LOGICAL).
  useEffect(() => {
    void invoke("set_continuum_open", { open });
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open]);

  const handleSelect = (entry: HistoryEntry) => {
    setOpen(false);
    void addTab(entry.url);
  };

  let lastDay = "";

  return (
    <AnimatePresence>
      {open && (
        <>
          <motion.div
            key="continuum-backdrop"
            className="absolute inset-0 z-30 bg-black/20"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
            onClick={() => setOpen(false)}
          />
          <motion.div
            key="continuum-panel"
            className="absolute right-0 top-0 z-40 flex h-full w-[400px] flex-col border-l border-[color:var(--color-border)] bg-[color:var(--color-surface)] shadow-[0_12px_32px_-8px_rgba(0,0,0,0.5)]"
            initial={{ x: 24, opacity: 0 }}
            animate={{ x: 0, opacity: 1 }}
            exit={{ x: 24, opacity: 0 }}
            transition={{ duration: 0.2, ease: "easeOut" }}
          >
            <div className="flex items-center justify-between px-4 pt-4">
              <span className="text-xs font-semibold tracking-wider text-[color:var(--color-text-primary)]">
                CONTINUUM
              </span>
              <button
                type="button"
                aria-label="Close"
                onClick={() => setOpen(false)}
                className="flex h-6 w-6 items-center justify-center rounded text-[color:var(--color-text-secondary)] hover:text-[color:var(--color-text-primary)]"
              >
                <X size={14} strokeWidth={1.75} />
              </button>
            </div>
            <p className="px-4 pb-4 pt-1 text-xs text-[color:var(--color-text-secondary)]">
              Browse through your recent context
            </p>

            <div className="flex-1 overflow-y-auto px-4 pb-4">
              {entries.length === 0 ? (
                <p className="text-sm text-[color:var(--color-text-secondary)]">Nothing recorded yet.</p>
              ) : (
                entries.map((entry) => {
                  const label = dayLabel(entry.timestamp);
                  const showHeader = label !== lastDay;
                  lastDay = label;
                  return (
                    <div key={entry.id}>
                      {showHeader && (
                        <div className="mb-1.5 mt-3 text-[10px] font-semibold tracking-wider text-[color:var(--color-text-secondary)] first:mt-0">
                          {label}
                        </div>
                      )}
                      <button
                        type="button"
                        onClick={() => handleSelect(entry)}
                        className="flex w-full items-start gap-2 rounded-md px-1.5 py-1.5 text-left hover:bg-[color:var(--color-surface-2)]"
                      >
                        <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-[color:var(--color-accent-2)]" />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm text-[color:var(--color-text-primary)]">
                            {entry.title || entry.url}
                          </span>
                          <span className="block truncate text-xs text-[color:var(--color-text-secondary)]">
                            {timeLabel(entry.timestamp)} · {entry.url}
                          </span>
                        </span>
                      </button>
                    </div>
                  );
                })
              )}
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}
