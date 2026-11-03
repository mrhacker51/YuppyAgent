import type { CellColorDto, TerminalCellDto } from "./protocol";

function sgrForColor(color: CellColorDto, fg: boolean): string {
  if (color.t === "default") return fg ? "39" : "49";
  if (color.t === "idx") {
    const i = color.i;
    if (i < 8) return String(30 + i + (fg ? 0 : 10));
    if (i < 16) return String(90 + (i - 8) + (fg ? 0 : 10));
    return `${fg ? 38 : 48};5;${i}`;
  }
  // Truecolor: xterm renders 38;2;r;g;b accurately for any index we can't map.
  return `${fg ? 38 : 48};2;${color.r};${color.g};${color.b}`;
}

interface CellStyle {
  bold: boolean;
  italic: boolean;
  underline: boolean;
  inverse: boolean;
  fgKey: string;
  bgKey: string;
}

const EMPTY_STYLE: CellStyle = {
  bold: false,
  italic: false,
  underline: false,
  inverse: false,
  fgKey: "default",
  bgKey: "default",
};

function styleOf(cell: TerminalCellDto | undefined): CellStyle {
  if (!cell) return EMPTY_STYLE;
  return {
    bold: cell.bold,
    italic: cell.italic,
    underline: cell.underline,
    inverse: cell.inverse,
    fgKey:
      cell.fg.t === "default"
        ? "default"
        : cell.fg.t === "idx"
          ? `idx:${cell.fg.i}`
          : `rgb:${cell.fg.r},${cell.fg.g},${cell.fg.b}`,
    bgKey:
      cell.bg.t === "default"
        ? "default"
        : cell.bg.t === "idx"
          ? `idx:${cell.bg.i}`
          : `rgb:${cell.bg.r},${cell.bg.g},${cell.bg.b}`,
  };
}

function styleDiff(prev: CellStyle, next: CellStyle, cell: TerminalCellDto | undefined): string {
  let sgr = "";
  const push = (code: string) => (sgr = sgr ? `${sgr};${code}` : code);
  if (next.bold !== prev.bold) push(next.bold ? "1" : "22");
  if (next.italic !== prev.italic) push(next.italic ? "3" : "23");
  if (next.underline !== prev.underline) push(next.underline ? "4" : "24");
  if (next.inverse !== prev.inverse) push(next.inverse ? "7" : "27");
  if (next.fgKey !== prev.fgKey && cell) push(sgrForColor(cell.fg, true));
  if (next.bgKey !== prev.bgKey && cell) push(sgrForColor(cell.bg, false));
  return sgr ? `[${sgr}m` : "";
}

/**
 * Per-row SGR snapshot lines (no newlines). `cellsToSgr` joins them with CRLF;
 * the incremental renderer in TerminalPane diffs them row by row instead of
 * rewriting the whole screen — full resets each frame are what make the CLIs
 * flicker the moment a prompt is submitted.
 */
export function screenToSgrLines(cells: TerminalCellDto[], rows: number, cols: number): string[] {
  const lines: string[] = [];
  for (let r = 0; r < rows; r++) {
    let line = "";
    let style: CellStyle = EMPTY_STYLE;
    let pendingSgr = "";
    let trimmedEnd = 0;
    for (let c = 0; c < cols; c++) {
      const cell = cells[r * cols + c];
      const next = styleOf(cell);
      pendingSgr += styleDiff(style, next, cell);
      style = next;
      const ch = cell?.ch && cell.ch !== " " ? cell.ch : " ";
      line += pendingSgr + ch;
      pendingSgr = "";
      if (ch !== " " || style.bgKey !== "default" || style.fgKey !== "default") {
        trimmedEnd = line.length;
      }
    }
    line = line.slice(0, trimmedEnd);
    if (trimmedEnd > 0) line += "\x1b[0m";
    lines.push(line);
  }
  return lines;
}

/**
 * Rebuild a full-screen cell snapshot as text with SGR escape sequences, so
 * xterm can reproduce the PTY screen with its real colors instead of flat
 * plaintext. Trailing blanks per line are trimmed; inter-cell blanks kept.
 */
export function cellsToSgr(cells: TerminalCellDto[], rows: number, cols: number): string {
  return screenToSgrLines(cells, rows, cols).join("\r\n");
}

/**
 * Plain-text rendering of a screen snapshot. Used by the "copy screen"
 * action and by compact previews (agent detail, reports), never as a source
 * of truth for the terminal itself.
 */
export function cellsToText(cells: TerminalCellDto[], rows: number, cols: number): string {
  const lines: string[] = [];
  for (let r = 0; r < rows; r++) {
    let line = "";
    for (let c = 0; c < cols; c++) {
      const ch = cells[r * cols + c]?.ch;
      line += ch && ch !== "" ? ch : " ";
    }
    lines.push(line.replace(/\s+$/, ""));
  }
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines.join("\n");
}

/**
 * Remove CLI chrome (box rules, the ❯ prompt line, "⏵⏵ auto mode",
 * "◐ medium · /effort") from a rendered frame. Needed when screen snapshots
 * are appended into a rolling transcript: without this the chrome of every
 * frame lands in the middle of a printed JSON block and breaks parsing.
 */
export function stripTerminalChrome(text: string): string {
  return text
    .split("\n")
    .filter((line) => {
      const t = line.trim();
      if (t === "") return false;
      if (/^[─━═=_-]{6,}$/.test(t)) return false; // rule
      if (/^[╭╰│┌└├┤┬┴┼]/.test(t)) return false; // box frame
      if (/^❯\s*$/.test(t)) return false; // empty prompt
      if (/^⏵⏵/.test(t)) return false; // auto mode hint
      if (/^[◐◑◒◓◔◕]\s/.test(t)) return false; // effort/model line
      if (/^\d+%\s*(context|left)/i.test(t)) return false;
      return true;
    })
    .join("\n");
}

/**
 * Wrap-aware rendering: a row whose LAST cell is occupied was hard-wrapped by
 * the terminal, so the next row continues the same logical line — join those
 * with "" (no separator), real line breaks with "\n". Unlike cellsToText this
 * preserves spaces at wrap points, which matters when the text is data (a
 * printed JSON plan) rather than prose.
 */
export function cellsToJoinedText(cells: TerminalCellDto[], rows: number, cols: number): string {
  const lines: string[] = [];
  for (let r = 0; r < rows; r++) {
    let line = "";
    for (let c = 0; c < cols; c++) {
      const ch = cells[r * cols + c]?.ch;
      line += ch && ch !== "" ? ch : " ";
    }
    lines.push(line);
  }
  let out = "";
  for (let r = 0; r < rows; r++) {
    if (r > 0) {
      const prev = lines[r - 1];
      const prevFull = prev.length > 0 && !/\s/.test(prev[prev.length - 1]);
      out += prevFull ? "" : "\n";
    }
    out += lines[r];
  }
  return out.replace(/[ \t]+$/gm, "").replace(/\n+$/, "");
}

/** Fragments that mean a seat's CLI is showing a question or a picker, not
 * its own composer. Matched case-insensitively over whitespace-collapsed
 * text, because the CLIs change wording and casing between releases:
 *  - Claude Code trust/theme dialogs: "Quick safety check … Yes, I trust this
 *    folder … Enter to confirm · Esc to cancel".
 *  - Codex 0.166 folder-trust dialog: "Folder access … Trust this folder? …
 *    › 1. Trust and continue  2. Back to Agent Command Center … enter
 *    continue · esc back". It is drawn ~0.3–0.8 s AFTER Codex first paints a
 *    normal "› Ask Codex to do anything" composer, and keystrokes typed into
 *    it navigate away (the prompt is lost, the seat ends up in the agent list).
 *  - Codex's Agent Command Center list ("esc back · enter open · n new"),
 *    which has no composer either.
 * A dialog is a human decision; typing over it would answer it blindly. */
export const SEAT_DIALOG_MARKERS: readonly string[] = [
  "trust this folder",
  "safety check",
  "enter to confirm",
  "esc to cancel",
  "folder access",
  "trust and continue",
  "enter continue",
  "esc back",
];

/** True when a seat's screen text is a dialog the operator must answer. */
export function seatShowsDialog(text: string): boolean {
  const flat = text.toLowerCase().replace(/\s+/g, " ");
  return SEAT_DIALOG_MARKERS.some((m) => flat.includes(m));
}
