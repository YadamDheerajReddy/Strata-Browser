import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Trash2 } from "lucide-react";
import type { HistoryEntry } from "../types/bookmark";

function formatTime(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

// A real page (App Flow doc: History opens "as a new page", not an overlay)
// — same idea as a browser's own history tab, filling the whole content
// area of its own tab (see App.tsx, tabsStore's "history" tab kind). Closed
// the same way any tab is: its × in the tab bar.
export function HistoryPanel({ onNavigate }: { onNavigate: (url: string) => void }) {
  const [entries, setEntries] = useState<HistoryEntry[]>([]);

  const load = () => {
    invoke<HistoryEntry[]>("list_history", { limit: 200 }).then(setEntries);
  };

  useEffect(load, []);

  const handleClear = async () => {
    await invoke("clear_history");
    load();
  };

  return (
    <div className="absolute inset-0 overflow-y-auto">
      <div className="mx-auto max-w-2xl px-8 py-10">
        <div className="mb-6 flex items-center justify-between">
          <h1 className="text-xl font-semibold text-[color:var(--color-text-primary)]">History</h1>
          <button
            type="button"
            onClick={handleClear}
            className="flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-sm text-[color:var(--color-text-secondary)] hover:bg-[color:var(--color-surface-2)] hover:text-[color:var(--color-text-primary)]"
          >
            <Trash2 size={14} strokeWidth={1.75} />
            Clear history
          </button>
        </div>

        {entries.length === 0 ? (
          <p className="text-sm text-[color:var(--color-text-secondary)]">No history yet.</p>
        ) : (
          <div className="overflow-hidden rounded-lg border border-[color:var(--color-border)]">
            {entries.map((entry) => (
              <button
                key={entry.id}
                type="button"
                onClick={() => onNavigate(entry.url)}
                className="flex w-full flex-col items-start gap-0.5 border-b border-[color:var(--color-border)] bg-[color:var(--color-surface)] px-4 py-3 text-left last:border-b-0 hover:bg-[color:var(--color-surface-2)]"
              >
                <span className="truncate text-sm text-[color:var(--color-text-primary)]">
                  {entry.title}
                </span>
                <span className="truncate text-xs text-[color:var(--color-text-secondary)]">
                  {formatTime(entry.timestamp)} · {entry.url}
                </span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
