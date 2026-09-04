import { AlertTriangle, RotateCw } from "lucide-react";
import { useTabsStore } from "../stores/tabsStore";
import type { Tab } from "../types/tab";

const REASON_COPY: Record<string, string> = {
  crashed: "This page stopped working.",
  killed: "This page was closed to free up memory.",
  oom: "This page ran out of memory.",
  abnormal: "This page stopped responding.",
};

// Crash recovery (Implementation Plan Phase 6, TRD §6: "a crashed renderer
// process must not take down the whole application"). The CEF browser
// behind a crashed tab survives but shows nothing at all — same "React
// can't draw over CEF" constraint as History/Downloads/Home, so a crashed
// tab is treated like an internal page and gets this instead, with a real
// way back in rather than a permanently blank rect.
export function CrashedPagePanel({ tab, reason }: { tab: Tab; reason: string | null }) {
  const reloadCrashedTab = useTabsStore((s) => s.reloadCrashedTab);

  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 px-8 text-center">
      <AlertTriangle size={32} strokeWidth={1.5} className="text-[color:var(--color-text-secondary)]" />
      <div>
        <p className="text-sm text-[color:var(--color-text-primary)]">
          {(reason && REASON_COPY[reason]) || REASON_COPY.crashed}
        </p>
        <p className="mt-1 truncate text-xs text-[color:var(--color-text-secondary)]">{tab.url}</p>
      </div>
      <button
        type="button"
        onClick={() => void reloadCrashedTab(tab.id)}
        className="flex items-center gap-1.5 rounded-md bg-[color:var(--color-accent)] px-3 py-1.5 text-sm font-medium text-white"
      >
        <RotateCw size={13} strokeWidth={2} />
        Reload
      </button>
    </div>
  );
}
