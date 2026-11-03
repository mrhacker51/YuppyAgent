import { memo } from "react";

/** Deterministic 8×8 pixel face from a seed string. Used anywhere an agent
 * needs a face (office sprites, chat bubbles). No external art — the sprite
 * is generated from the string. */

const SKIN = ["#f2c89b", "#dbae7e", "#c68b5c", "#a9714b", "#7a4a2e", "#5b3520", "#ecd9b0"];
const HAIR = ["#241610", "#3b2314", "#1f1410", "#6b3f1d", "#8a5a2b", "#57524a", "#c9c2b4", "#f97316"];
const BODY = ["#f97316", "#4ade80", "#22d3ee", "#a78bfa", "#f472b6", "#facc15", "#38bdf8", "#fb7185"];
const EYE = "#120a08";

function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export type Sprite = {
  skin: string;
  hair: string;
  body: string;
  eyeRow: number;
  mouth: number;
  hairPuff: boolean;
};

export function spriteFromSeed(seed: string): Sprite {
  const h = hashString(seed || "agent");
  return {
    skin: SKIN[h % SKIN.length],
    hair: HAIR[(h >>> 3) % HAIR.length],
    body: BODY[(h >>> 6) % BODY.length],
    eyeRow: (h >>> 9) % 2,
    mouth: (h >>> 11) % 3,
    hairPuff: ((h >>> 13) & 1) === 1,
  };
}

/** Ink one 8×8 face into a canvas pixel buffer (used by the office map). */
export function paintSprite(ctx: CanvasRenderingContext2D, px: number, py: number, seed: string, scale = 1) {
  const s = spriteFromSeed(seed);
  const P = (x: number, y: number, c: string) => {
    ctx.fillStyle = c;
    ctx.fillRect(px + x * scale, py + y * scale, scale, scale);
  };
  // hair crown
  for (let x = 1; x <= 6; x++) P(x, 0, s.hair);
  P(0, 1, s.hair);
  P(7, 1, s.hair);
  P(0, 2, s.skin);
  P(7, 2, s.skin);
  for (let x = 1; x <= 6; x++) P(x, 1, s.hair);
  // face
  for (let y = 2; y <= 5; y++) for (let x = 1; x <= 6; x++) P(x, y, s.skin);
  // hairPuff: side locks
  if (s.hairPuff) {
    P(0, 3, s.hair);
    P(7, 3, s.hair);
  }
  // eyes
  const ey = s.eyeRow ? 3 : 4;
  P(2, ey, EYE);
  P(5, ey, EYE);
  // mouth
  if (s.mouth === 0) {
    P(3, 5, EYE);
    P(4, 5, EYE);
  } else if (s.mouth === 1) {
    for (let x = 3; x <= 4; x++) P(x, 5, "#8a3a2a");
  } else {
    P(3, 5, EYE);
  }
  // body / overalls
  for (let x = 1; x <= 6; x++) {
    P(x, 6, s.body);
    P(x, 7, s.body);
  }
  P(0, 6, s.body);
  P(7, 6, s.body);
  // belt
  P(3, 7, EYE);
  P(4, 7, EYE);
}

export default memo(function PixelAvatar({
  seed,
  size = 24,
  className = "",
}: {
  seed: string;
  size?: number;
  className?: string;
}) {
  const s = spriteFromSeed(seed);
  const cells: Array<[number, number, string]> = [];
  const put = (x: number, y: number, c: string) => cells.push([x, y, c]);
  for (let x = 1; x <= 6; x++) put(x, 0, s.hair);
  put(0, 1, s.hair);
  put(7, 1, s.hair);
  for (let x = 1; x <= 6; x++) put(x, 1, s.hair);
  for (let y = 2; y <= 5; y++) for (let x = 0; x <= 7; x++) {
    if (x === 0 || x === 7) {
      if (y === 2) put(x, y, s.skin);
      else if (s.hairPuff && y === 3) put(x, y, s.hair);
      continue;
    }
    put(x, y, s.skin);
  }
  const ey = s.eyeRow ? 3 : 4;
  put(2, ey, EYE);
  put(5, ey, EYE);
  if (s.mouth === 0) {
    put(3, 5, EYE);
    put(4, 5, EYE);
  } else if (s.mouth === 1) {
    put(3, 5, "#8a3a2a");
    put(4, 5, "#8a3a2a");
  } else {
    put(3, 5, EYE);
  }
  for (let x = 0; x <= 7; x++) {
    for (const y of [6, 7]) put(x, y, s.body);
  }
  put(3, 7, EYE);
  put(4, 7, EYE);
  return (
    <svg
      viewBox="0 0 8 8"
      width={size}
      height={size}
      role="img"
      aria-hidden
      className={`pixel-avatar shrink-0 ${className}`}
      shapeRendering="crispEdges"
    >
      <rect width="8" height="8" fill="#0d0807" />
      {cells.map(([x, y, c], i) => (
        <rect key={i} x={x} y={y} width="1" height="1" fill={c} />
      ))}
    </svg>
  );
});
