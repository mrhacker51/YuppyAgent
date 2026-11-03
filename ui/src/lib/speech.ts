/**
 * Speech classification for the "ne diyor" panel.
 *
 * The office chat tab shows the LAST verbatim line each live seat printed.
 * A CLTI redraws its TUI constantly, so most captured lines are chrome
 * ("⏵⏵ auto mode", box rules, spinners). Those are not something an agent
 * "said" and they must never occupy the one line we show.
 *
 * `pickSpeechLine` walks the captured lines newest-first and returns the first
 * that carries real content, tagged with what it is. No text is invented or
 * rewritten — only filtered and labelled.
 */

export type SpeechKind = "message" | "team" | "command" | "output";

export interface ClassifiedLine {
  text: string;
  kind: SpeechKind;
}

/** Team-bus traffic as it appears in a CLI's own transcript. */
const TEAM_PATTERNS = [
  /yuppy_(send|inbox|team|wait|history)/i,
  /^\[#\d+\] from /i,
  /\(to everyone\)/i,
];

const COMMAND_PATTERNS = [
  /^\$\s+\S/,
  /^❯\s+\S/,
  /^>\s+\S/,
  /^\s*⎿\s+/,
  /^\s*(Bash|Read|Write|Edit|Grep|Glob|Task)\(/,
];

/** Chrome that is never a spoken line. */
export function isSpeechNoise(line: string): boolean {
  // CLIs prefix hints with prompt glyphs and spinners ("❯ Try…", "› Ask…",
  // "▝▝ /path", ">_ OpenAI…"). Strip any leading run of non-word decoration so
  // the patterns below see the sentence underneath.
  const raw = line.trim();
  // Spinner/mode rows are chrome at the glyph itself; stripping the glyph
  // would turn "⏵⏵ auto mode" into a plausible sentence.
  if (/^(⏵⏵|[◐◑◒◓◔◕])/.test(raw)) return true;
  if (/^[·•]\s*(worked|done)/i.test(raw)) return true;
  if (/^\?\s+for shortcuts/i.test(raw)) return true;
  // Box-drawing / block art is a banner, not a sentence.
  if (/[█▀▄▌▐░▒▓]/.test(raw)) return true;
  if (/\bfor shortcuts\b|\bfor agents\b|\besc to interrupt\b/i.test(raw)) return true;
  if (/^api usage billing$/i.test(raw)) return true;
  // Model/endpoint banners ("Qwen3.8 Flash Next (Evren) default…") name the
  // runtime, not something the agent decided to say.
  if (/\(evren\)|\bmodel\b.*\(.*\)$/i.test(raw)) return true;
  const t = raw.replace(/^[^\p{L}\p{N}$~/]+/u, "").trim();
  if (!t) return true;
  if (t.length < 3) return true;
  if (/^[─━═=_-]{3,}$/.test(t)) return true;
  if (/^[╭╰│┌└├┤┬┴┼]/.test(t)) return true;
  if (/^❯\s*$/.test(t)) return true;
  if (/^⏵⏵/.test(t)) return true;
  if (/^[◐◑◒◓◔◕]\s/.test(t)) return true;
  if (/^\d+%\s*(context|left)/i.test(t)) return true;
  if (/^(shift\+tab|ctrl\+|esc )/i.test(t)) return true;
  // CLI onboarding hints and key legend rows are UI, not something an agent said.
  if (/^try\s+["“']/i.test(t)) return true;
  if (/^ask\s+(claude|codex|agent)\s+to\b/i.test(t)) return true;
  if (/^\?\s+for shortcuts/i.test(t)) return true;
  if (/^(esc|enter|tab|shift\+tab|ctrl\+[a-z])\b/i.test(t)) return true;
  // Boot/status chrome and bare paths are real output, not a spoken sentence.
  if (/^(loading|starting|initializing|booting|ready|connected|disconnected)\b/i.test(t)) return true;
  if (/^(\/|~\/)[\w./-]+$/.test(t)) return true;
  if (/^(welcome to|openai codex|claude code v)/i.test(t)) return true;
  if (/^\W{2,}$/.test(t)) return true;
  // Tool spinners and their "⎿" gutter are progress chrome, not a statement.
  if (/^⎿\s*(running|working|thinking|…|\.\.\.)/i.test(t)) return true;
  if (/^⎿\s*$/.test(t)) return true;
  if (/^(thinking|thought for|cooking|baking|cogitat|running|working)\b/i.test(t)) return true;
  if (/^[·•]\s*(worked|done)/i.test(t)) return true;
  return false;
}

export function classifySpeechLine(line: string): ClassifiedLine {
  const text = line.trim();
  if (TEAM_PATTERNS.some((re) => re.test(text))) return { text, kind: "team" };
  if (COMMAND_PATTERNS.some((re) => re.test(text))) return { text, kind: "command" };
  // A sentence with letters and spaces is treated as prose the agent wrote.
  if (/[a-zA-ZçğıöşüÇĞİÖŞÜ]{3,}/.test(text) && /\s/.test(text)) {
    return { text, kind: "message" };
  }
  return { text, kind: "output" };
}

/**
 * Newest meaningful line, or null when the seat has produced nothing but
 * chrome since it opened.
 */
export function pickSpeechLine(lines: readonly string[]): ClassifiedLine | null {
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (isSpeechNoise(line)) continue;
    return classifySpeechLine(line);
  }
  return null;
}
