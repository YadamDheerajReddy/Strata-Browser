import { useEffect, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { useTabsStore } from "../stores/tabsStore";
import { saveCurrentMoment } from "../lib/moments";

// Save Moment always prompts for a name up front (App Flow doc §6) — the
// one modal in an otherwise modal-free app, reserved for the one action
// where naming genuinely matters (a Moment is meant to be found again
// later by that name).
export function SaveMomentDialog() {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onOpen = () => {
      const { tabs, activeTabId } = useTabsStore.getState();
      const activeTab = tabs.find((t) => t.id === activeTabId);
      setName(activeTab?.kind === "web" ? activeTab.title : "");
      setError(null);
      setOpen(true);
    };
    window.addEventListener("strata:save-moment", onOpen);
    return () => window.removeEventListener("strata:save-moment", onOpen);
  }, []);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open]);

  const handleSave = async () => {
    if (!name.trim() || saving) return;
    setSaving(true);
    setError(null);
    try {
      await saveCurrentMoment(name.trim());
      setOpen(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't save this Moment");
    } finally {
      setSaving(false);
    }
  };

  return (
    <AnimatePresence>
      {open && (
        <>
          <motion.div
            key="save-moment-backdrop"
            className="absolute inset-0 z-40 bg-black/30"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
            onClick={() => setOpen(false)}
          />
          <motion.div
            key="save-moment-dialog"
            className="absolute left-1/2 top-1/3 z-50 w-96 -translate-x-1/2 rounded-lg border border-[color:var(--color-border)] bg-[color:var(--color-surface)] p-4 shadow-[0_12px_32px_-8px_rgba(0,0,0,0.5)]"
            initial={{ opacity: 0, y: -8, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -8, scale: 0.98 }}
            transition={{ duration: 0.15 }}
          >
            <h2 className="mb-3 text-sm font-semibold text-[color:var(--color-text-primary)]">
              Save Current Moment
            </h2>
            <input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void handleSave();
              }}
              placeholder="Name this Moment"
              className="mb-2 w-full rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg)] px-3 py-2 text-sm text-[color:var(--color-text-primary)] outline-none focus:border-[color:var(--color-accent)]"
            />
            {error && <p className="mb-2 text-xs text-red-400">{error}</p>}
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="rounded-md px-3 py-1.5 text-sm text-[color:var(--color-text-secondary)] hover:bg-[color:var(--color-surface-2)]"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void handleSave()}
                disabled={!name.trim() || saving}
                className="rounded-md bg-[color:var(--color-accent)] px-3 py-1.5 text-sm font-medium text-white disabled:opacity-40"
              >
                {saving ? "Saving…" : "Save Moment"}
              </button>
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}
