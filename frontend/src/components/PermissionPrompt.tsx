import { useEffect, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { ShieldQuestion } from "lucide-react";

interface PermissionRequest {
  id: number;
  origin: string;
  kind: string;
}

function originHost(origin: string): string {
  try {
    return new URL(origin).host || origin;
  } catch {
    return origin;
  }
}

// Alloy style (see strata_bridge.cpp's runtime_style) has no built-in
// permission UI at all — every camera/microphone/location/notifications
// request CEF forwards here (see cef_bridge.rs's set_permission_forwarding)
// would otherwise just be silently denied with nothing shown to the user.
// Requests queue one at a time rather than stacking, since more than one
// at once is rare and a stack of prompts is more confusing than useful.
export function PermissionPrompt() {
  const [queue, setQueue] = useState<PermissionRequest[]>([]);

  useEffect(() => {
    const unlisten = listen<PermissionRequest>("permission-request", (event) => {
      setQueue((q) => [...q, event.payload]);
    });
    return () => {
      void unlisten.then((f) => f());
    };
  }, []);

  const current = queue[0];

  const respond = (allow: boolean) => {
    if (!current) return;
    void invoke("respond_permission_request", { id: current.id, allow });
    setQueue((q) => q.slice(1));
  };

  return (
    <AnimatePresence>
      {current && (
        <motion.div
          key={current.id}
          initial={{ opacity: 0, y: -8 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -8 }}
          transition={{ duration: 0.15 }}
          className="absolute left-1/2 top-2 z-40 flex -translate-x-1/2 items-center gap-3 rounded-lg border border-[color:var(--color-border)] bg-[color:var(--color-surface)] px-4 py-2.5 shadow-[0_12px_32px_-8px_rgba(0,0,0,0.5)]"
        >
          <ShieldQuestion size={16} strokeWidth={1.75} className="shrink-0 text-[color:var(--color-accent)]" />
          <span className="text-sm text-[color:var(--color-text-primary)]">
            <strong className="font-semibold">{originHost(current.origin)}</strong> wants {current.kind}
          </span>
          <div className="flex shrink-0 items-center gap-1.5">
            <button
              type="button"
              onClick={() => respond(false)}
              className="rounded-md px-2.5 py-1 text-xs text-[color:var(--color-text-secondary)] hover:bg-[color:var(--color-surface-2)] hover:text-[color:var(--color-text-primary)]"
            >
              Block
            </button>
            <button
              type="button"
              onClick={() => respond(true)}
              className="rounded-md bg-[color:var(--color-accent)] px-2.5 py-1 text-xs font-medium text-white"
            >
              Allow
            </button>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
