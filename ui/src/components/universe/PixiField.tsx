"use client";

import { useEffect, useRef, useState } from "react";

/**
 * High-count 2D particle field for the React Flow map.
 *
 * PixiJS is imported lazily so it only ships to clients that actually open
 * the 2D mode. Particles are decoration; the React Flow graph on top remains
 * the single source of truth.
 */
export default function PixiField({
  density = 1,
  reducedMotion = false,
}: {
  density?: number;
  reducedMotion?: boolean;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const host = hostRef.current;
    if (!host || reducedMotion) return;
    let cancelled = false;
    let destroy: (() => void) | null = null;

    const start = async () => {
      try {
        const { Application, Particle, ParticleContainer, Texture } = await import("pixi.js");
        if (cancelled || !host) return;

        const textureCanvas = document.createElement("canvas");
        textureCanvas.width = textureCanvas.height = 64;
        const ctx = textureCanvas.getContext("2d");
        if (ctx) {
          const grad = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
          grad.addColorStop(0, "rgba(255,255,255,1)");
          grad.addColorStop(0.28, "rgba(255,255,255,0.7)");
          grad.addColorStop(1, "rgba(255,255,255,0)");
          ctx.fillStyle = grad;
          ctx.fillRect(0, 0, 64, 64);
        }
        const texture = Texture.from(textureCanvas);

        const app = new Application();
        await app.init({
          backgroundAlpha: 0,
          resizeTo: host,
          antialias: true,
          autoDensity: true,
          resolution: Math.min(2, window.devicePixelRatio || 1),
          preference: "webgl",
          powerPreference: "high-performance",
        });
        if (cancelled) {
          app.destroy(true, { children: true, texture: true });
          return;
        }

        const canvas = app.canvas;
        canvas.style.position = "absolute";
        canvas.style.inset = "0";
        canvas.style.width = "100%";
        canvas.style.height = "100%";
        canvas.style.pointerEvents = "none";
        host.appendChild(canvas);

        const count = Math.round(
          Math.min(1800, Math.max(180, 900 * density)),
        );
        const container = new ParticleContainer({
          dynamicProperties: { position: true, scale: true, color: true },
        });
        app.stage.addChild(container);

        const colors = [0x22d3ee, 0xf97316, 0xa78bfa, 0x94a3b8, 0xe7e5e4];
        const particles: Array<{
          particle: InstanceType<typeof Particle>;
          vx: number;
          vy: number;
          baseScale: number;
          phase: number;
        }> = [];

        const width = host.clientWidth || 800;
        const height = host.clientHeight || 600;

        for (let i = 0; i < count; i++) {
          const hot = Math.random() > 0.9;
          const scale = (hot ? 0.05 : 0.02) + Math.random() * (hot ? 0.09 : 0.05);
          const color = colors[Math.floor(Math.random() * colors.length)];
          const particle = new Particle({
            texture,
            x: Math.random() * width,
            y: Math.random() * height,
            anchorX: 0.5,
            anchorY: 0.5,
            scaleX: scale,
            scaleY: scale,
            tint: color,
            alpha: hot ? 0.85 : 0.25 + Math.random() * 0.4,
          });
          container.addParticle(particle);
          particles.push({
            particle,
            vx: (Math.random() - 0.5) * (hot ? 26 : 7),
            vy: -4 - Math.random() * (hot ? 22 : 6),
            baseScale: scale,
            phase: Math.random() * Math.PI * 2,
          });
        }

        const pointer = { x: -9999, y: -9999, active: false };
        const onMove = (event: PointerEvent) => {
          const rect = host.getBoundingClientRect();
          pointer.x = event.clientX - rect.left;
          pointer.y = event.clientY - rect.top;
          pointer.active = true;
        };
        const onLeave = () => {
          pointer.active = false;
        };
        window.addEventListener("pointermove", onMove, { passive: true });
        window.addEventListener("pointerleave", onLeave);

        const ticker = (tickerState: { deltaMS: number }) => {
          const dt = Math.min(0.05, tickerState.deltaMS / 1000);
          const w = host.clientWidth || width;
          const h = host.clientHeight || height;
          const elapsed = performance.now() / 1000;
          for (const entry of particles) {
            const p = entry.particle;
            p.x += entry.vx * dt;
            p.y += entry.vy * dt;

            if (pointer.active) {
              const dx = p.x - pointer.x;
              const dy = p.y - pointer.y;
              const dist2 = dx * dx + dy * dy;
              if (dist2 < 150 * 150 && dist2 > 1) {
                const force = (150 - Math.sqrt(dist2)) / 150;
                p.x += (dx / Math.sqrt(dist2)) * force * 22 * dt;
                p.y += (dy / Math.sqrt(dist2)) * force * 22 * dt;
              }
            }

            if (p.y < -8) {
              p.y = h + 8;
              p.x = Math.random() * w;
            }
            if (p.x < -8) p.x = w + 8;
            if (p.x > w + 8) p.x = -8;

            const twinkle = 0.75 + Math.sin(elapsed * 1.6 + entry.phase) * 0.25;
            p.scaleX = entry.baseScale * twinkle;
            p.scaleY = entry.baseScale * twinkle;
          }
        };
        app.ticker.add(ticker);

        destroy = () => {
          window.removeEventListener("pointermove", onMove);
          window.removeEventListener("pointerleave", onLeave);
          app.ticker.remove(ticker);
          try {
            texture.destroy(true);
            app.destroy(true, { children: true, texture: true });
          } catch {
            // already destroyed by the WebGL context loss path
          }
        };
      } catch {
        if (!cancelled) setFailed(true);
      }
    };

    void start();

    return () => {
      cancelled = true;
      destroy?.();
    };
  }, [density, reducedMotion]);

  if (reducedMotion || failed) return null;

  return (
    <div
      ref={hostRef}
      className="pointer-events-none absolute inset-0 overflow-hidden"
      aria-hidden
    />
  );
}
