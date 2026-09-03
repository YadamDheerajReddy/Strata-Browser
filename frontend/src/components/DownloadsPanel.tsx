import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { FileDown } from "lucide-react";
import type { DownloadEntry } from "../types/download";

function formatBytes(bytes: number | null): string {
  if (bytes == null) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// A real page (App Flow doc: Downloads opens "as a new page", not an
// overlay) — same idea as a browser's own downloads tab, filling the whole
// content area of its own tab (see App.tsx, tabsStore's "downloads" tab
// kind). Closed the same way any tab is: its × in the tab bar.
export function DownloadsPanel() {
  const [entries, setEntries] = useState<DownloadEntry[]>([]);

  useEffect(() => {
    const load = () => invoke<DownloadEntry[]>("list_downloads").then(setEntries);
    load();
    // A download started/progressing/finishing anywhere emits this (see
    // lib.rs's handle_download_event) — without it, a download that starts
    // while this tab is already open would never show up until reopened.
    const unlisten = listen("downloads-changed", load);
    return () => {
      void unlisten.then((f) => f());
    };
  }, []);

  return (
    <div className="absolute inset-0 overflow-y-auto">
      <div className="mx-auto max-w-2xl px-8 py-10">
        <h1 className="mb-6 text-xl font-semibold text-[color:var(--color-text-primary)]">
          Downloads
        </h1>

        {entries.length === 0 ? (
          <p className="text-sm text-[color:var(--color-text-secondary)]">No downloads yet.</p>
        ) : (
          <div className="overflow-hidden rounded-lg border border-[color:var(--color-border)]">
            {entries.map((entry) => (
              <div
                key={entry.id}
                className="flex items-start gap-2.5 border-b border-[color:var(--color-border)] bg-[color:var(--color-surface)] px-4 py-3 last:border-b-0"
              >
                <FileDown
                  size={16}
                  strokeWidth={1.75}
                  className="mt-0.5 shrink-0 text-[color:var(--color-text-secondary)]"
                />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm text-[color:var(--color-text-primary)]">
                    {entry.fileName}
                  </p>
                  <p className="truncate text-xs text-[color:var(--color-text-secondary)]">
                    {entry.status}
                    {entry.sizeBytes != null ? ` · ${formatBytes(entry.sizeBytes)}` : ""}
                  </p>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
