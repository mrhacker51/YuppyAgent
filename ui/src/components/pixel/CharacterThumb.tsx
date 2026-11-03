"use client";

import { useEffect, useRef, useState } from "react";

/**
 * A square head crop from a character sprite sheet, used in the picker and in
 * "ne diyor". It reads the same PNG the office draws, so the thumbnail can
 * never disagree with the body walking around the map.
 *
 * Sprites are loaded once per `src` and cached at module scope; the canvas is
 * sized in device pixels so the crop stays crisp on a HiDPI screen.
 */

const cache = new Map<string, HTMLImageElement>();
const waiters = new Map<string, Array<() => void>>();

export function loadSprite(src: string): HTMLImageElement | null {
  if (typeof window === "undefined") return null;
  const hit = cache.get(src);
  if (hit) return hit.complete && hit.naturalWidth > 0 ? hit : null;
  const img = new Image();
  img.decoding = "async";
  img.src = src;
  cache.set(src, img);
  img.addEventListener("load", () => {
    for (const fn of waiters.get(src) ?? []) fn();
    waiters.delete(src);
  });
  return null;
}

export default function CharacterThumb({
  sprite,
  size = 22,
  facing = "front-left",
  className,
}: {
  /** Body name, e.g. "Claude-1". */
  sprite: string;
  size?: number;
  facing?: "front-left" | "front-right" | "rear-left" | "rear-right";
  className?: string;
}) {
  const src = `/office/characters/${sprite}-${facing}.png`;
  const ref = useRef<HTMLCanvasElement>(null);
  // Bumped when the image finishes loading; the draw effect depends on it, so
  // the crop appears without re-rendering on every office frame.
  const [loadTick, setLoadTick] = useState(0);

  useEffect(() => {
    if (loadSprite(src)) return;
    const list = waiters.get(src) ?? [];
    const fn = () => setLoadTick((n) => n + 1);
    list.push(fn);
    waiters.set(src, list);
    return () => {
      const arr = waiters.get(src);
      if (!arr) return;
      const i = arr.indexOf(fn);
      if (i >= 0) arr.splice(i, 1);
    };
  }, [src]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const img = loadSprite(src);
    const ctx = el.getContext("2d");
    if (!ctx) return;
    const dpr = typeof window === "undefined" ? 1 : Math.min(3, window.devicePixelRatio || 1);
    const px = Math.round(size * dpr);
    if (el.width !== px || el.height !== px) {
      el.width = px;
      el.height = px;
    }
    ctx.clearRect(0, 0, px, px);
    if (!img) return;
    // The head sits in the top third of the sheet, inset from the arms.
    const sx = img.naturalWidth * 0.2;
    const sy = img.naturalHeight * 0.015;
    const sw = img.naturalWidth * 0.6;
    const sh = img.naturalHeight * 0.34;
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(img, sx, sy, sw, sh, 0, 0, px, px);
  }, [src, size, loadTick]);

  return (
    <canvas
      ref={ref}
      width={size}
      height={size}
      aria-hidden

      className={className}
      style={{ width: size, height: size, imageRendering: "pixelated" }}
    />
  );
}
