/**
 * Terminal typography.
 *
 * xterm.js does not put `fontFamily` on a DOM element — it writes the string
 * straight into a 2D canvas (`ctx.font = "12px " + fontFamily`). The canvas
 * font shorthand is strict CSS: a `var(…)` reference is *not* substituted
 * there, so passing a CSS variable makes the whole assignment invalid and the
 * canvas silently keeps its default `10px sans-serif`. That is exactly why the
 * hosted Claude Code / Codex screens rendered in a proportional UI face with
 * broken glyph metrics instead of the deck's real monospace type.
 *
 * The fix is to resolve the app's font variable to a literal family list
 * before handing it to xterm, and to re-apply it once webfonts finish loading
 * (`font-display: swap` means the first measurement happens with the fallback).
 */

/** The variable `next/font` exposes on `<html>` (see `src/app/layout.tsx`). */
export const TERMINAL_FONT_VAR = "--font-geist-mono";

/**
 * Generic CSS font keywords. The canvas font shorthand accepts exactly one
 * generic family and it must be last, so any of these in the middle of the
 * list would invalidate the string and silently reset the canvas font.
 */
const GENERIC_KEYWORDS = [
  "serif",
  "sans-serif",
  "ui-serif",
  "ui-sans-serif",
  "monospace",
  "ui-monospace",
  "monospace-serif",
  "cursive",
  "fantasy",
  "system-ui",
  "ui-rounded",
  "math",
  "emoji",
  "fangsong",
  "auto",
];

/** Real terminal faces that ship with the OSes the desktop shell runs on.
 * Always appended last so a missing webfont still lands on a fixed-pitch face
 * (box drawing and block glyphs included). */
export const TERMINAL_FONT_FALLBACKS =
  'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "DejaVu Sans Mono", "Liberation Mono", monospace';

/** Turn untrusted CSS text into something safe to splice into a font list. */
export function sanitizeFontList(value: string | null | undefined): string {
  if (!value) return "";
  const flat = value.replace(/[\r\n\t]+/g, " ").replace(/[;{}]/g, " ").trim();
  if (!flat) return "";
  // Split on commas that are not inside quotes, then drop generic keywords.
  const parts: string[] = [];
  let current = "";
  let quote = "";
  for (const ch of flat) {
    if (quote) {
      current += ch;
      if (ch === quote) quote = "";
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === ",") {
      parts.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  parts.push(current);
  return parts
    .map((part) => part.trim())
    .filter((part) => part && !GENERIC_KEYWORDS.includes(part.toLowerCase()))
    .join(", ");
}

/**
 * Build the literal family list xterm needs. `cssVarValue` is the resolved
 * value of the app's font variable; when it is missing (font still loading,
 * or no variable at all) the OS terminal stack is used on its own.
 */
export function terminalFontFamily(cssVarValue?: string | null): string {
  const list = sanitizeFontList(cssVarValue);
  return list ? `${list}, ${TERMINAL_FONT_FALLBACKS}` : TERMINAL_FONT_FALLBACKS;
}

/** Read the app's font variable off the document and resolve it. */
export function readTerminalFontFamily(): string {
  if (typeof window === "undefined") return TERMINAL_FONT_FALLBACKS;
  try {
    const raw = window
      .getComputedStyle(document.documentElement)
      .getPropertyValue(TERMINAL_FONT_VAR);
    return terminalFontFamily(raw);
  } catch {
    // A detached document (unmount race) must not break the terminal.
    return TERMINAL_FONT_FALLBACKS;
  }
}

/**
 * Has the app's mono webfont actually been downloaded and parsed? xterm
 * measures glyph advance widths once per font change; re-applying the family
 * after this resolves to true is what stops the first frame from being laid
 * out on fallback metrics.
 */
export function terminalFontIsReady(family: string): boolean {
  if (typeof document === "undefined" || !("fonts" in document)) return true;
  try {
    // `FontFaceSet.check` needs a valid font shorthand; probe the first family.
    const first = sanitizeFontList(family).split(",")[0]?.trim();
    if (!first) return true;
    return document.fonts.check(`12px ${first}`);
  } catch {
    return true;
  }
}
