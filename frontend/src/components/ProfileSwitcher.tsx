import { useEffect, useRef, useState } from "react";
import { Plus, VenetianMask } from "lucide-react";
import { useProfilesStore } from "../stores/profilesStore";
import { useTabsStore } from "../stores/tabsStore";

// Closes every open tab and lands on a single fresh one — used whenever
// the active profile changes, since a tab's browser/history/bookmarks all
// belong to whichever profile was active when it was created and have no
// sane meaning under a different one.
async function resetTabsForProfileSwitch() {
  const { tabs, closeTab, addTab } = useTabsStore.getState();
  for (const tab of tabs) {
    // Without quitIfEmpty:false, closing the last tab in this loop would
    // close the whole window before addTab() below gets a chance to open
    // the new profile's first tab.
    await closeTab(tab.id, { quitIfEmpty: false });
  }
  await addTab();
}

export function ProfileSwitcher() {
  const profiles = useProfilesStore((s) => s.profiles);
  const activeProfile = useProfilesStore((s) => s.activeProfile);
  const isGuest = useProfilesStore((s) => s.isGuest);
  const refresh = useProfilesStore((s) => s.refresh);
  const switchTo = useProfilesStore((s) => s.switchTo);
  const switchToGuest = useProfilesStore((s) => s.switchToGuest);
  const create = useProfilesStore((s) => s.create);

  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    const onClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
        setCreating(false);
      }
    };
    document.addEventListener("mousedown", onClickOutside);
    return () => document.removeEventListener("mousedown", onClickOutside);
  }, []);

  const handleSwitch = async (id: string) => {
    setOpen(false);
    await switchTo(id);
    await resetTabsForProfileSwitch();
  };

  const handleGuest = async () => {
    setOpen(false);
    switchToGuest();
    await resetTabsForProfileSwitch();
  };

  const handleCreate = async () => {
    const name = newName.trim();
    if (!name) return;
    await create(name);
    setNewName("");
    setCreating(false);
  };

  const label = isGuest ? "Guest" : activeProfile?.name ?? "";
  const initial = isGuest ? "G" : (activeProfile?.name?.[0] ?? "?").toUpperCase();
  const color = isGuest ? "var(--color-text-secondary)" : activeProfile?.avatarColor;

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label="Switch profile"
        title={label}
        className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[10px] font-semibold text-white"
        style={{ backgroundColor: color }}
      >
        {isGuest ? <VenetianMask size={12} strokeWidth={2} /> : initial}
      </button>

      {open && (
        <div className="absolute right-0 top-7 z-30 w-56 rounded-lg border border-[color:var(--color-border)] bg-[color:var(--color-surface)] py-1.5 shadow-[0_12px_32px_-8px_rgba(0,0,0,0.5)]">
          {profiles.map((p) => (
            <button
              key={p.id}
              type="button"
              onClick={() => void handleSwitch(p.id)}
              className={`flex w-full items-center gap-2.5 px-3 py-1.5 text-left text-sm hover:bg-[color:var(--color-surface-2)] ${
                !isGuest && p.id === activeProfile?.id
                  ? "text-[color:var(--color-text-primary)]"
                  : "text-[color:var(--color-text-secondary)]"
              }`}
            >
              <span
                className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[9px] font-semibold text-white"
                style={{ backgroundColor: p.avatarColor }}
              >
                {p.name[0]?.toUpperCase()}
              </span>
              <span className="flex-1 truncate">{p.name}</span>
              {!isGuest && p.id === activeProfile?.id && (
                <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-[color:var(--color-accent)]" />
              )}
            </button>
          ))}

          <button
            type="button"
            onClick={() => void handleGuest()}
            className={`flex w-full items-center gap-2.5 px-3 py-1.5 text-left text-sm hover:bg-[color:var(--color-surface-2)] ${
              isGuest ? "text-[color:var(--color-text-primary)]" : "text-[color:var(--color-text-secondary)]"
            }`}
          >
            <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-[color:var(--color-surface-2)] text-[color:var(--color-text-secondary)]">
              <VenetianMask size={11} strokeWidth={1.75} />
            </span>
            <span className="flex-1 truncate">Guest</span>
            {isGuest && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-[color:var(--color-accent)]" />}
          </button>

          <div className="my-1 border-t border-[color:var(--color-border)]" />

          {creating ? (
            <div className="flex items-center gap-1.5 px-3 py-1.5">
              <input
                autoFocus
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void handleCreate();
                  if (e.key === "Escape") setCreating(false);
                }}
                placeholder="Profile name"
                className="min-w-0 flex-1 rounded border border-[color:var(--color-border)] bg-[color:var(--color-bg)] px-2 py-1 text-sm text-[color:var(--color-text-primary)] outline-none"
              />
              <button
                type="button"
                onClick={() => void handleCreate()}
                disabled={!newName.trim()}
                className="rounded px-2 py-1 text-xs text-[color:var(--color-accent)] disabled:opacity-30"
              >
                Add
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setCreating(true)}
              className="flex w-full items-center gap-2.5 px-3 py-1.5 text-left text-sm text-[color:var(--color-text-secondary)] hover:bg-[color:var(--color-surface-2)] hover:text-[color:var(--color-text-primary)]"
            >
              <Plus size={14} strokeWidth={1.75} />
              New profile
            </button>
          )}
        </div>
      )}
    </div>
  );
}
