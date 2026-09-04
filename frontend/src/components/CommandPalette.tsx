import { useEffect, useMemo, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { invoke } from "@tauri-apps/api/core";
import {
  ChevronsRight,
  Download,
  History,
  Plus,
  RotateCcw,
  RotateCw,
  Save,
  Search,
  Snowflake,
  Star,
  VenetianMask,
  X,
  type LucideIcon,
} from "lucide-react";
import type { Action } from "../types/action";

interface Command {
  id: Action;
  label: string;
  icon: LucideIcon;
  shortcut: string;
}

// Every browser and Strata-specific action currently wired up (App.tsx's
// full Action union) — UI/UX Brief §5: "Fully keyboard-accessible; every
// browser and Strata-specific action is reachable without a mouse." Split
// View and Settings from the brief's own mockup are left out entirely
// rather than listed as dead entries — neither exists yet.
const COMMANDS: Command[] = [
  { id: "open_continuum", label: "Open Continuum", icon: RotateCcw, shortcut: "Ctrl+Shift+R" },
  { id: "save_moment", label: "Save Current Moment", icon: Save, shortcut: "Ctrl+Shift+M" },
  { id: "freeze_moment", label: "Freeze Moment", icon: Snowflake, shortcut: "Ctrl+Shift+F" },
  { id: "new_tab", label: "New Tab", icon: Plus, shortcut: "Ctrl+T" },
  { id: "new_private_tab", label: "New Private Tab", icon: VenetianMask, shortcut: "Ctrl+Shift+N" },
  { id: "close_tab", label: "Close Tab", icon: X, shortcut: "Ctrl+W" },
  { id: "next_tab", label: "Next Tab", icon: ChevronsRight, shortcut: "Ctrl+Tab" },
  { id: "reload", label: "Reload", icon: RotateCw, shortcut: "Ctrl+R" },
  { id: "focus_address_bar", label: "Focus Address Bar", icon: Search, shortcut: "Ctrl+L" },
  { id: "bookmark", label: "Bookmark Page", icon: Star, shortcut: "Ctrl+D" },
  { id: "history", label: "History", icon: History, shortcut: "Ctrl+H" },
  { id: "downloads", label: "Downloads", icon: Download, shortcut: "Ctrl+J" },
];

// Ctrl+K (UI/UX Brief §5) — the discoverability layer for every shortcut
// above, not the primary interaction model for power users who already
// know them (see the brief's own framing).
export function CommandPalette() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return COMMANDS;
    return COMMANDS.filter((c) => c.label.toLowerCase().includes(q));
  }, [query]);

  useEffect(() => {
    const onOpen = () => {
      setQuery("");
      setSelected(0);
      setOpen(true);
    };
    window.addEventListener("strata:open-command-palette", onOpen);
    return () => window.removeEventListener("strata:open-command-palette", onOpen);
  }, []);

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  useEffect(() => {
    setSelected(0);
  }, [query]);

  // Same clipping issue ContinuumPanel/SaveMomentDialog had — the CEF
  // browser behind whatever tab is active always paints on top of this
  // webview's own content unless it's explicitly hidden first (see
  // set_modal_open in lib.rs).
  useEffect(() => {
    void invoke("set_modal_open", { open });
  }, [open]);

  const run = (command: Command) => {
    setOpen(false);
    window.dispatchEvent(new CustomEvent<Action>("strata:action", { detail: command.id }));
  };

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        setSelected((i) => Math.min(i + 1, results.length - 1));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setSelected((i) => Math.max(i - 1, 0));
      } else if (e.key === "Enter") {
        e.preventDefault();
        const command = results[selected];
        if (command) run(command);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, results, selected]);

  return (
    <AnimatePresence>
      {open && (
        <>
          <motion.div
            key="command-palette-backdrop"
            className="absolute inset-0 z-40 bg-black/30"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
            onClick={() => setOpen(false)}
          />
          <motion.div
            key="command-palette"
            className="absolute left-1/2 top-1/4 z-50 w-[440px] -translate-x-1/2 overflow-hidden rounded-lg border border-[color:var(--color-border)] bg-[color:var(--color-surface)] shadow-[0_12px_32px_-8px_rgba(0,0,0,0.5)]"
            initial={{ opacity: 0, y: -8, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -8, scale: 0.98 }}
            transition={{ duration: 0.15 }}
          >
            <div className="flex items-center gap-2 border-b border-[color:var(--color-border)] px-3 py-2.5">
              <Search size={14} strokeWidth={1.75} className="shrink-0 text-[color:var(--color-text-secondary)]" />
              <input
                ref={inputRef}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search Strata…"
                className="w-full bg-transparent text-sm text-[color:var(--color-text-primary)] outline-none placeholder:text-[color:var(--color-text-secondary)]"
              />
            </div>
            <div className="max-h-80 overflow-y-auto p-1.5">
              {results.length === 0 ? (
                <p className="px-3 py-4 text-center text-sm text-[color:var(--color-text-secondary)]">
                  No matching commands.
                </p>
              ) : (
                results.map((command, i) => {
                  const Icon = command.icon;
                  return (
                    <button
                      key={command.id}
                      type="button"
                      onMouseEnter={() => setSelected(i)}
                      onClick={() => run(command)}
                      className={`flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-sm ${
                        i === selected
                          ? "bg-[color:var(--color-surface-2)] text-[color:var(--color-text-primary)]"
                          : "text-[color:var(--color-text-secondary)]"
                      }`}
                    >
                      <Icon size={14} strokeWidth={1.75} className="shrink-0" />
                      <span className="flex-1 truncate">{command.label}</span>
                      <span className="shrink-0 text-xs text-[color:var(--color-text-secondary)]">
                        {command.shortcut}
                      </span>
                    </button>
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
