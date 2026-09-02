import { Minus, Square, X } from "lucide-react";
import { getCurrentWindow } from "@tauri-apps/api/window";

const appWindow = getCurrentWindow();

// Windows-style window controls (minimize/maximize/close) for our custom,
// decorations-disabled title bar — see UI/UX Brief §1: the goal is a
// minimal, premium chrome, not a stock OS titlebar.
export function WindowControls() {
  return (
    <div className="flex h-full items-stretch">
      <button
        type="button"
        aria-label="Minimize"
        onClick={() => appWindow.minimize()}
        className="flex w-11 items-center justify-center text-[color:var(--color-text-secondary)] transition-colors hover:bg-[color:var(--color-surface-2)] hover:text-[color:var(--color-text-primary)]"
      >
        <Minus size={14} strokeWidth={1.75} />
      </button>
      <button
        type="button"
        aria-label="Maximize"
        onClick={() => appWindow.toggleMaximize()}
        className="flex w-11 items-center justify-center text-[color:var(--color-text-secondary)] transition-colors hover:bg-[color:var(--color-surface-2)] hover:text-[color:var(--color-text-primary)]"
      >
        <Square size={12} strokeWidth={1.75} />
      </button>
      <button
        type="button"
        aria-label="Close"
        onClick={() => appWindow.close()}
        className="flex w-11 items-center justify-center text-[color:var(--color-text-secondary)] transition-colors hover:bg-red-600 hover:text-white"
      >
        <X size={14} strokeWidth={1.75} />
      </button>
    </div>
  );
}
