"use client";

/**
 * FancyUI's ThinkingIndicator label: the activity word is a light band that
 * sweeps across the glyphs, so a live-but-quiet agent still reads as "working"
 * without a spinner fighting the terminal it belongs to.
 *
 * Purely presentational; callers pass the real activity text.
 */
export default function ShimmerText({
  children,
  className = "",
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return <span className={`fx-shimmer ${className}`}>{children}</span>;
}
