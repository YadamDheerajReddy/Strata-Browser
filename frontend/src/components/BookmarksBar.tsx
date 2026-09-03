import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Globe, X } from "lucide-react";
import { useBookmarksStore } from "../stores/bookmarksStore";
import { useTabsStore } from "../stores/tabsStore";

function BookmarkChip({
  id,
  url,
  title,
  faviconUrl,
}: {
  id: string;
  url: string;
  title: string;
  faviconUrl: string | null;
}) {
  const [faviconFailed, setFaviconFailed] = useState(false);
  const remove = useBookmarksStore((s) => s.remove);
  const tabs = useTabsStore((s) => s.tabs);
  const activeTabId = useTabsStore((s) => s.activeTabId);
  const addTab = useTabsStore((s) => s.addTab);
  const navigateFromHome = useTabsStore((s) => s.navigateFromHome);

  const open = () => {
    const activeTab = tabs.find((t) => t.id === activeTabId);
    if (activeTab?.kind === "web" && activeTab.browserId != null) {
      invoke("navigate", { browserId: activeTab.browserId, url });
    } else if (activeTab?.kind === "home") {
      void navigateFromHome(activeTab.id, url);
    } else {
      void addTab(url);
    }
  };

  return (
    <button
      type="button"
      onClick={open}
      title={url}
      className="group flex h-6 max-w-40 shrink-0 items-center gap-1.5 rounded-md px-2 text-xs text-[color:var(--color-text-secondary)] transition-colors hover:bg-[color:var(--color-surface-2)] hover:text-[color:var(--color-text-primary)]"
    >
      {faviconUrl && !faviconFailed ? (
        <img
          src={faviconUrl}
          alt=""
          className="h-3.5 w-3.5 shrink-0 rounded-sm"
          onError={() => setFaviconFailed(true)}
        />
      ) : (
        <Globe size={12} strokeWidth={1.75} className="shrink-0" />
      )}
      <span className="truncate">{title}</span>
      <span
        role="button"
        aria-label="Remove bookmark"
        onClick={(e) => {
          e.stopPropagation();
          void remove(id);
        }}
        className="shrink-0 rounded p-0.5 opacity-0 transition-opacity group-hover:opacity-100 hover:bg-black/20"
      >
        <X size={10} strokeWidth={2} />
      </span>
    </button>
  );
}

// A classic browser bookmarks bar — sits right under the address bar
// (App Flow doc: bookmarking a page should make it show up somewhere
// persistent, not just live in the History panel's list). Always rendered
// at a fixed height, empty state and all, rather than appearing/
// disappearing based on whether there are any bookmarks yet: the content
// area's real screen space is CEF's, positioned from Rust using a chrome
// height that's a fixed constant (see lib.rs's CHROME_HEIGHT_LOGICAL) —
// this bar's height is baked into that constant, so it can't come and go
// without the two sides falling out of sync.
export function BookmarksBar() {
  const bookmarks = useBookmarksStore((s) => s.bookmarks);
  const refresh = useBookmarksStore((s) => s.refresh);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return (
    <div className="flex h-8 shrink-0 items-center gap-0.5 overflow-x-auto border-b border-[color:var(--color-border)] bg-[color:var(--color-bg)] px-2">
      {bookmarks.length === 0 ? (
        <span className="px-1 text-xs text-[color:var(--color-text-secondary)]">
          Bookmarks you save will appear here
        </span>
      ) : (
        bookmarks.map((b) => (
          <BookmarkChip key={b.id} id={b.id} url={b.url} title={b.title} faviconUrl={b.faviconUrl} />
        ))
      )}
    </div>
  );
}
