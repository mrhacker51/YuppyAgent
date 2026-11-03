"use client";

import { useMemo } from "react";
import dynamic from "next/dynamic";

/**
 * The deck's atmosphere: three static aurora washes, a fine dot lattice and a
 * vignette. All of it is decorative (`aria-hidden`), fixed, and never blocks
 * a pointer. The animated grid is loaded client-only: it is a canvas effect,
 * so it must not run during the static export or the first paint.
 *
 * Intensity is deliberately low. This sits behind terminal text all day; a
 * background that competes with a PTY is a bug, not a style.
 */
const FlickeringGrid = dynamic(
  () => import("fancy-ui-react").then((m) => m.FlickeringGrid),
  { ssr: false, loading: () => null },
);

export default function DeckBackground() {
  // One instance, memoised: the grid reseeds on every mount otherwise.
  const grid = useMemo(
    () => (
      <FlickeringGrid
        className="pointer-events-none absolute inset-0 opacity-[0.16]"
        squareSize={3}
        gridGap={7}
        flickerChance={0.06}
        color="currentColor"
        maxOpacity={0.5}
        seed={7}
      />
    ),
    [],
  );

  return (
    <div aria-hidden className="pointer-events-none fixed inset-0 z-0 overflow-hidden text-accent">
      {/* Aurora: teal from the top-left, indigo from the top-right, a warm
          ember low-centre so the deck is not a single-hue blue. */}
      <div className="absolute -left-[18rem] -top-[22rem] size-[46rem] rounded-full bg-[radial-gradient(circle,rgba(94,234,212,0.11),transparent_62%)] blur-2xl" />
      <div className="absolute -right-[20rem] -top-[20rem] size-[48rem] rounded-full bg-[radial-gradient(circle,rgba(139,156,247,0.13),transparent_64%)] blur-2xl" />
      <div className="absolute bottom-[-26rem] left-1/3 h-[38rem] w-[52rem] -translate-x-1/2 rounded-full bg-[radial-gradient(ellipse,rgba(251,191,36,0.045),transparent_68%)] blur-3xl" />
      {/* Fine lattice, faded to nothing at the edges. */}
      <div className="deck-lattice absolute inset-0 opacity-[0.5]" />
      {grid}
      {/* Vignette keeps the centre of the screen the brightest place. */}
      <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_50%_0%,transparent_35%,rgba(3,6,10,0.55)_100%)]" />
    </div>
  );
}
