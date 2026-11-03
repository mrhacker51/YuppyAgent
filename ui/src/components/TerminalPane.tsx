"use client";

import { memo, useEffect, useRef } from "react";
import "@xterm/xterm/css/xterm.css";
import { useHudStore, type Session } from "@/lib/store";
import { screenToSgrLines } from "@/lib/term";
import { readTerminalFontFamily, terminalFontIsReady } from "@/lib/termFont";

/**
 * Live view of one hosted CLI PTY session (Claude Code / Codex). Input is
 * forwarded verbatim over the bridge; the screen is repainted from full
 * cell snapshots emitted by the backend PTY emulator.
 */
function TerminalPane({ session, autoFocus = true }: { session: Session; autoFocus?: boolean }) {
  const send = useHudStore((s) => s.send);
  const preset = useHudStore((s) => s.seatSizePreset);
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<{
    write(data: string): void;
    reset(): void;
    rows: number;
    cols: number;
    dispose(): void;
    focus(): void;
    scrollToTop(): void;
    resize(cols: number, rows: number): void;
  } | null>(null);
  const lastGenRef = useRef<number>(-1);
  /** Snapshot we last painted; row-diff avoids clearing the whole screen on
   * every frame — full resets are what made the CLIs flicker on submit. */
  const paintedRef = useRef<{ rows: number; cols: number; lines: string[] } | null>(null);

  useEffect(() => {
    let disposed = false;
    let ro: ResizeObserver | null = null;
    let initialTimer: ReturnType<typeof setTimeout> | null = null;
    let roTimer: ReturnType<typeof setTimeout> | null = null;
    const div = containerRef.current;
    if (!div) return;

    (async () => {
      const [{ Terminal }, { FitAddon }] = await Promise.all([
        import("@xterm/xterm"),
        import("@xterm/addon-fit"),
      ]);
      if (disposed || !containerRef.current) return;

      // xterm draws on a canvas, so the family list must be literal — a CSS
      // variable there is silently rejected and the canvas falls back to a
      // proportional UI font. Resolve the deck's mono variable first.
      const fontFamily = readTerminalFontFamily();

      const term = new Terminal({
        theme: {
          background: "#0c0c0e",
          foreground: "#e7e5e4",
          cursor: "#f97316",
          cursorAccent: "#0c0c0e",
          selectionBackground: "rgba(249,115,22,0.26)",
          black: "#171717",
          red: "#ef4444",
          green: "#22c55e",
          yellow: "#eab308",
          blue: "#60a5fa",
          magenta: "#c084fc",
          cyan: "#22d3ee",
          white: "#a8a29e",
          brightBlack: "#525252",
          brightRed: "#f87171",
          brightGreen: "#4ade80",
          brightYellow: "#facc15",
          brightBlue: "#93c5fd",
          brightMagenta: "#d8b4fe",
          brightCyan: "#67e8f9",
          brightWhite: "#fafafa",
        },
        fontFamily,
        fontSize: 12,
        cursorBlink: true,
        scrollback: 3000,
        convertEol: false,
      });
      const fit = new FitAddon();
      term.loadAddon(fit);
      term.open(div);
      fit.fit();
      termRef.current = term;
      lastGenRef.current = -1;
      if (autoFocus) term.focus();

      term.onData((data) => {
        send({ type: "terminal_input", session_id: session.id, bytes: data });
      });

      // Fit after React layout settles, then keep the PTY in sync on resize.
      // A manual size preset wins over auto-fit: the operator chose it.
      const pushSize = () => {
        try {
          let rows: number;
          let cols: number;
          if (preset !== "auto") {
            cols = preset.cols;
            rows = preset.rows;
            term.resize(cols, rows);
          } else {
            // The PTY must be EXACTLY the pane's grid: a wider PTY renders
            // lines the card clips, which is what hid CLI output. Only guard
            // against degenerate sizes while the pane is still 0×0.
            fit.fit();
            cols = Math.max(20, term.cols);
            rows = Math.max(6, term.rows);
            term.resize(cols, rows);
          }
          send({
            type: "terminal_resize",
            session_id: session.id,
            rows,
            cols,
          });
        } catch {
          // ignore resize races while the pane is being remounted
        }
      };
      // `font-display: swap` means the first glyph measurement can happen on
      // the fallback face. When the real font lands, xterm must re-measure and
      // the PTY must follow the new cell grid, or CLI output wraps wrongly.
      if (!terminalFontIsReady(fontFamily) && typeof document !== "undefined" && document.fonts) {
        document.fonts.ready
          .then(() => {
            if (disposed || !termRef.current) return;
            const ready = readTerminalFontFamily();
            if (term.options.fontFamily !== ready) term.options.fontFamily = ready;
            pushSize();
          })
          .catch(() => {
            // A font that never loads must not take the terminal down.
          });
      }

      initialTimer = setTimeout(pushSize, 50);
      ro = new ResizeObserver(() => {
        if (preset !== "auto") return; // the preset owns the size
        try {
          fit.fit();
        } catch {
          // ignore
        }
        if (roTimer) clearTimeout(roTimer);
        roTimer = setTimeout(pushSize, 150);
      });
      ro.observe(div);
    })();

    return () => {
      disposed = true;
      if (initialTimer) clearTimeout(initialTimer);
      if (roTimer) clearTimeout(roTimer);
      ro?.disconnect();
      termRef.current?.dispose();
      termRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.id, preset]);

  // Repaint the newest full-screen snapshot — incrementally, row by row.
  // The bridge sends a whole cell matrix per frame; resetting + rewriting it
  // each time made every character typed shimmer. We now only repaint rows
  // whose SGR text actually changed, then place the cursor.
  useEffect(() => {
    const term = termRef.current;
    const screen = session.lastScreen;
    if (!term || !screen || screen.type !== "terminal_screen") return;
    if (screen.generation === lastGenRef.current) return;
    lastGenRef.current = screen.generation;
    const lines = screenToSgrLines(screen.cells, screen.rows, screen.cols);
    const painted = paintedRef.current;
    const shapeChanged =
      !painted || painted.rows !== screen.rows || painted.cols !== screen.cols;
    if (shapeChanged) {
      // Every seat is fitted to its pane, so the renderer is never grown
      // here — that would push the CLI's text outside the visible card.
      try {
        term.reset();
      } catch {
        // ignore
      }
      term.write(lines.join("\r\n"));
      const [cr, cc] = screen.cursor ?? [0, 0];
      term.write(`\x1b[${cr + 1};${cc + 1}H`);
      paintedRef.current = { rows: screen.rows, cols: screen.cols, lines };
      return;
    }
    const chunks: string[] = [];
    const prev = painted.lines;
    for (let r = 0; r < lines.length; r++) {
      if (lines[r] === prev[r]) continue;
      chunks.push(`\x1b[${r + 1};1H\x1b[2K${lines[r]}`);
    }
    // Pin the caret to the PTY's own cursor — otherwise xterm leaves it at
    // the end of the last redrawn row, not where the user is typing.
    const [cr, cc] = screen.cursor ?? [0, 0];
    chunks.push(`\x1b[${cr + 1};${cc + 1}H`);
    term.write(chunks.join(""));
    paintedRef.current = { rows: screen.rows, cols: screen.cols, lines };
  }, [session.lastScreen, session.generation]);

  return <div ref={containerRef} className="h-full w-full" />;
}

export default memo(TerminalPane);
