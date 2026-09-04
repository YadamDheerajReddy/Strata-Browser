import { motion, AnimatePresence } from "framer-motion";
import { useMomentsStore } from "../stores/momentsStore";

// Moment restoration transition (UI/UX Brief §8: "brief 'Restoring
// Moment…' list of tab names, then a natural transition into the restored
// workspace — never an abrupt cut"). Rendered once at the App root, not
// inside HomePage — a restore switches the active tab away from the
// homepage partway through (see lib/moments.ts's restoreMoment), which
// would otherwise unmount this before it's done, and let the CEF browser
// being revealed (a native window that always paints on top of this
// webview's own content) show through it looking clipped.
export function RestoringMomentOverlay() {
  const restoring = useMomentsStore((s) => s.restoring);

  return (
    <AnimatePresence>
      {restoring && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.2 }}
          className="pointer-events-none absolute inset-0 z-50 flex items-center justify-center bg-[color:var(--color-bg)]/90 backdrop-blur-sm"
        >
          <div className="rounded-xl border border-[color:var(--color-border)] bg-[color:var(--color-surface)] px-6 py-5 text-center shadow-[0_12px_32px_-8px_rgba(0,0,0,0.5)]">
            <p className="mb-3 text-sm text-[color:var(--color-text-secondary)]">
              Restoring <span className="text-[color:var(--color-text-primary)]">{restoring.name}</span>…
            </p>
            <ul className="space-y-1">
              {restoring.tabs.map((title, i) => (
                <motion.li
                  key={i}
                  initial={{ opacity: 0, x: -6 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ delay: i * 0.08 }}
                  className="text-xs text-[color:var(--color-text-secondary)]"
                >
                  <span className="mr-1.5 inline-block h-1.5 w-1.5 rounded-full bg-[color:var(--color-accent-2)]" />
                  {title}
                </motion.li>
              ))}
            </ul>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
