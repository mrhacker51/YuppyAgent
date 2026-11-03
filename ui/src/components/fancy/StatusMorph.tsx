"use client";

/**
 * FancyUI's StatusMorph: a 1em status glyph that closes a spinning ring into
 * a drawn check or cross. Used for the connection state, where a static dot
 * could not show "reconnecting" versus "connected" without reading a label.
 *
 * The SVG shares one stroke language at every state, so the icon never
 * changes size or jumps inside its box.
 */
export default function StatusMorph({
  state,
  size = 12,
  title,
}: {
  state: "idle" | "loading" | "success" | "error";
  size?: number;
  title?: string;
}) {
  const tone =
    state === "success"
      ? "text-ok"
      : state === "error"
        ? "text-danger"
        : state === "loading"
          ? "text-warn"
          : "text-text-lo";

  return (
    <span
      className={`inline-grid shrink-0 place-items-center ${tone}`}
      style={{ width: size, height: size }}
      role={title ? "img" : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
    >
      <svg viewBox="0 0 16 16" width={size} height={size} fill="none" aria-hidden>
        {state === "idle" && <circle cx="8" cy="8" r="3" fill="currentColor" opacity="0.55" />}

        {state === "loading" && (
          <>
            <circle cx="8" cy="8" r="5.6" stroke="currentColor" strokeOpacity="0.22" strokeWidth="1.6" />
            <path
              d="M8 2.4a5.6 5.6 0 0 1 5.6 5.6"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinecap="round"
              className="fx-status-spin"
              style={{ transformOrigin: "8px 8px" }}
            />
          </>
        )}

        {state === "success" && (
          <>
            <circle cx="8" cy="8" r="5.6" stroke="currentColor" strokeOpacity="0.3" strokeWidth="1.4" />
            <path
              d="M5 8.3 7.1 10.4 11.2 6.1"
              stroke="currentColor"
              strokeWidth="1.7"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="fx-status-draw"
            />
          </>
        )}

        {state === "error" && (
          <>
            <circle cx="8" cy="8" r="5.6" stroke="currentColor" strokeOpacity="0.3" strokeWidth="1.4" />
            <path
              d="M5.6 5.6 10.4 10.4M10.4 5.6 5.6 10.4"
              stroke="currentColor"
              strokeWidth="1.7"
              strokeLinecap="round"
              className="fx-status-draw"
            />
          </>
        )}
      </svg>
    </span>
  );
}
