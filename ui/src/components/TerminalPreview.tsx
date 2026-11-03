"use client";

import { useEffect, useState } from "react";
import { useHudStore } from "@/lib/store";
import { cellsToText } from "@/lib/term";

/**
 * A real PTY's last painted frame as plain text — no xterm, no canvas, no
 * scrollback. Used where a second interactive view of the same session would
 * fight the matrix terminal over the PTY size: a compact monitor shows the
 * same bytes at ~1 Hz, and clicking it focuses the one real terminal.
 *
 * The component subscribes to nothing: the 1 Hz tick reads the latest frame
 * from the store by id, so a busy PTY does not re-render every card around
 * it. Nothing is generated here; an empty frame says so instead of inventing
 * output.
 */
export default function TerminalPreview({
  sessionId,
  label,
  maxLines = 18,
}: {
  sessionId: string;
  label?: string;
  maxLines?: number;
}) {
  const [text, setText] = useState("");

  useEffect(() => {
    const read = () => {
      const session = useHudStore.getState().sessions.find((s) => s.id === sessionId);
      const screen = session?.lastScreen;
      if (!screen || screen.type !== "terminal_screen") {
        setText("");
        return;
      }
      const lines = cellsToText(screen.cells, screen.rows, screen.cols).split("\n");
      // The PTY paints a full row matrix; trailing blank rows would push the
      // real prompt off the top of a short monitor. Keep the last written
      // lines, bottom-anchored like a terminal.
      let end = lines.length;
      while (end > 0 && lines[end - 1].trim() === "") end -= 1;
      setText(lines.slice(Math.max(0, end - maxLines), end).join("\n"));
    };
    read();
    const timer = setInterval(read, 10000);
    return () => clearInterval(timer);
  }, [sessionId, maxLines]);

  return (
    <div className="absolute inset-0 flex flex-col justify-end overflow-hidden px-1.5 py-1">
      <pre
        aria-label={`${label ?? "ajan"} canlı terminal önizlemesi`}
        className="m-0 w-full overflow-hidden whitespace-pre font-mono text-[10px] leading-[1.2] text-text-mid/75"
      >
        {text || "ekran bekleniyor…"}
      </pre>
      <span className="pointer-events-none absolute bottom-1 right-1.5 rounded-sm border border-line/60 bg-bg-0/85 px-1 font-mono text-[7px] uppercase tracking-wider text-text-lo">
        son kare · odakla
      </span>
    </div>
  );
}
