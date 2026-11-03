"use client";

import { useEffect, useRef } from "react";
import { Toaster, toast } from "fancy-ui-react";
import { useHudStore } from "@/lib/store";

/**
 * App-wide toast viewport plus the bridge log bridge.
 *
 * The store is the only source of messages: every toast below is a real
 * `warn`/`error` line that already exists in `logs`, never a synthesised
 * status. `seen` dedupes by log id so StrictMode remounts, re-renders and
 * history rehydration cannot replay the same failure twice.
 */
export default function ToasterHost() {
  const logs = useHudStore((s) => s.logs);
  const seen = useRef<Set<string>>(new Set());

  useEffect(() => {
    for (const entry of logs) {
      if (entry.level !== "warn" && entry.level !== "error") continue;
      if (seen.current.has(entry.id)) continue;
      seen.current.add(entry.id);
      toast({
        title: entry.level === "error" ? "Bridge hatası" : "Bridge uyarısı",
        description: entry.message,
        variant: entry.level === "error" ? "error" : "info",
        duration: entry.level === "error" ? 9000 : 6500,
        progress: true,
      });
    }
  }, [logs]);

  return <Toaster position="bottom-right" />;
}
