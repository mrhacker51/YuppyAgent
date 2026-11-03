/**
 * URL linkification for operator-visible text (bridge logs, feed). Every
 * http(s) URL becomes a real control: click opens it in the external
 * browser (same openExternal path as the Tarayıcı tab). Nothing is
 * fabricated — only URLs that actually appear in backend text are linked.
 */
import { openExternal, normalizeUrl } from "@/lib/browser";

const URL_RE = /https?:\/\/[^\s"'<>()[\]{}|\\^`]+/gi;

function linkify(text: string): React.ReactNode {
  URL_RE.lastIndex = 0;
  const parts: React.ReactNode[] = [];
  let cursor = 0;
  let key = 0;
  let m: RegExpExecArray | null;
  while ((m = URL_RE.exec(text)) !== null) {
    const raw = m[0];
    const url = normalizeUrl(raw);
    if (!url) continue;
    if (m.index > cursor) parts.push(text.slice(cursor, m.index));
    parts.push(
      <button
        key={key++}
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          void openExternal(url);
        }}
        title={`${url} — dış tarayıcıda aç`}
        className="break-all text-accent underline decoration-accent/40 underline-offset-2 transition-colors hover:text-accent-hi hover:decoration-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/60"
      >
        {raw}
      </button>,
    );
    cursor = m.index + raw.length;
  }
  if (cursor < text.length) parts.push(text.slice(cursor));
  return parts.length === 0 ? text : parts;
}

export default function Linkified({ children }: { children: string }): React.ReactNode {
  return <>{linkify(children)}</>;
}
