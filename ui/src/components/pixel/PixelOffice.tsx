"use client";

import { useEffect, useMemo, useRef } from "react";
import { useHudStore } from "@/lib/store";
import { planSeats, type SeatSpec, type SeatDepartment, type SeatAgent } from "@/lib/autoTerminals";
import { paintSprite } from "./PixelAvatar";

/**
 * Ofis — the pixel-art office. Every live or idle CLI seat is a character at
 * a desk; live PTYs glow green and type, closed seats slump gray. Everything
 * drawn here is real: seats come from the department/CLI inventory the bridge
 * reports, never invented.
 */

const W = 320;
const H = 180;
/** Compress long department names so they fit a zone header. */
function shortDeptLabel(name: string): string {
  const map: Array<[RegExp, string]> = [
    [/software\s*dev/i, "Yazılım"],
    [/code\s*review/i, "Review"],
    [/research/i, "Araştırma"],
    [/youtube/i, "YouTube"],
    [/finance|finans/i, "Finans"],
    [/custom/i, "Özel"],
    [/test|review/i, "Test"],
  ];
  for (const [re, label] of map) if (re.test(name)) return label.toUpperCase();
  const words = name.trim().split(/\s+/);
  return (words[0] ?? name).slice(0, 12).toUpperCase();
}

const ZONE_TINTS = ["#241611", "#201512", "#1c130f", "#261a12"];
const FLOOR_A = "#1a100c";
const FLOOR_B = "#201410";
const WALL = "#2c1a14";
const WALL_DARK = "#1f110c";
const DESK = "#3d2b1f";
const DESK_TOP = "#4a3524";
const MONITOR = "#18201f";
const GLOW = "#22d3ee";
const PLANT = "#3f7a3f";

type Desk = { seat: SeatSpec; x: number; y: number; z: number; live: boolean };

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export default function PixelOffice() {
  const departments = useHudStore((s) => s.departments);
  const agents = useHudStore((s) => s.agents);
  const sessions = useHudStore((s) => s.sessions);
  const focusSession = useHudStore((s) => s.focusSession);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const desksRef = useRef<Desk[]>([]);

  // Seat → live session (same greedy match the terminal matrix uses).
  const seats = useMemo(
    () => planSeats(departments as SeatDepartment[], agents as SeatAgent[]),
    [departments, agents],
  );
  const liveKeys = useMemo(() => {
    const pool = [...sessions];
    const live = new Set<string>();
    for (const seat of seats) {
      const i = pool.findIndex(
        (s) => s.agent === seat.agent && (s.department === seat.department || !s.department),
      );
      if (i >= 0) {
        live.add(seat.seatKey);
        pool.splice(i, 1);
      }
    }
    return live;
  }, [seats, sessions]);

  const deptSeatCount = useMemo(() => {
    const map = new Map<string, number>();
    for (const s of seats) map.set(s.department, (map.get(s.department) ?? 0) + 1);
    return map;
  }, [seats]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.imageSmoothingEnabled = false;

    // ---- layout: zones (departments) grid, up to 4
    const enabledDepts = (departments[0]?.id ? departments : [])
      .filter((d) => d.enabled)
      .map((d) => ({ id: d.id, name: d.name }));
    const zoneCount = Math.max(1, Math.min(4, enabledDepts.length || 1));
    const cols = zoneCount <= 2 ? zoneCount : 2;
    const rows = Math.ceil(zoneCount / cols);
    const pad = 10;
    const zoneW = (W - pad * 2) / cols;
    const zoneH = (H - pad * 2) / rows;

    const zones: Array<{ x: number; y: number; w: number; h: number; label: string; tint: string }> = [];
    for (let i = 0; i < zoneCount; i++) {
      const cx = i % cols;
      const cy = Math.floor(i / cols);
      const dept = enabledDepts[i];
      zones.push({
        x: pad + cx * zoneW,
        y: pad + cy * zoneH,
        w: zoneW - 4,
        h: zoneH - 4,
        label: shortDeptLabel(dept?.name ?? "Ofis"),
        tint: ZONE_TINTS[i % ZONE_TINTS.length],
      });
    }

    // ---- seat → desk assignment: seats map to zones by department ORDER
    const deptIndex = new Map(enabledDepts.map((d, i) => [d.id, i]));
    const seatsByDept = new Map<string, SeatSpec[]>();
    for (const s of seats) {
      const key = deptIndex.has(s.department) ? s.department : enabledDepts[0]?.id ?? "ofis";
      const arr = seatsByDept.get(key) ?? [];
      arr.push(s);
      seatsByDept.set(key, arr);
    }
    const desks: Desk[] = [];
    const zonesWithSeats = new Set<number>();
    for (const [deptId, dseats] of seatsByDept) {
      const zi = deptIndex.get(deptId) ?? 0;
      const zone = zones[Math.min(zi, zones.length - 1)] ?? zones[0];
      zonesWithSeats.add(Math.min(zi, zones.length - 1));
      // grid the desks inside the zone
      const inZone = dseats.length;
      const dcols = Math.max(1, Math.floor(Math.sqrt(inZone * (zone.w / zone.h))));
      const drows = Math.ceil(inZone / dcols);
      const cellW = (zone.w - 20) / dcols;
      const cellH = (zone.h - 26) / drows;
      dseats.forEach((seat, i) => {
        const dx = zone.x + 10 + (i % dcols) * cellW + cellW / 2 - 8;
        const dy = zone.y + 22 + Math.floor(i / dcols) * cellH + cellH / 2;
        desks.push({
          seat,
          x: Math.round(dx),
          y: Math.round(dy),
          z: hash(seat.seatKey) % 4,
          live: liveKeys.has(seat.seatKey),
        });
      });
    }
    desksRef.current = desks;

    let frame = 0;
    let raf = 0;

    const draw = () => {
      frame++;
      // floor checkerboard
      for (let y = 0; y < H; y += 8) {
        for (let x = 0; x < W; x += 8) {
          ctx.fillStyle = ((x + y) / 8) % 2 === 0 ? FLOOR_A : FLOOR_B;
          ctx.fillRect(x, y, 8, 8);
        }
      }
      // outer wall
      ctx.fillStyle = WALL;
      ctx.fillRect(0, 0, W, 6);
      ctx.fillRect(0, H - 6, W, 6);
      ctx.fillRect(0, 0, 6, H);
      ctx.fillRect(W - 6, 0, 6, H);
      ctx.fillStyle = WALL_DARK;
      ctx.fillRect(0, 6, W, 2);
      ctx.fillRect(0, H - 8, W, 2);
      // windows on the top wall
      for (let i = 0; i < 5; i++) {
        const wx = 30 + i * 76;
        ctx.fillStyle = "#0d1a1e";
        ctx.fillRect(wx, 1, 20, 4);
        ctx.fillStyle = "#2a4a52";
        ctx.fillRect(wx + 1, 2, 18, 2);
      }
      // door at bottom center
      ctx.fillStyle = "#3d2b1f";
      ctx.fillRect(W / 2 - 12, H - 6, 24, 6);
      ctx.fillStyle = "#f97316";
      ctx.fillRect(W / 2 - 1, H - 4, 2, 2);

      // zones
      const zoneSeatCount = new Map<number, { total: number; live: number }>();
      for (const d of desks) {
        // find the zone index of the desk by nearest zone bounds
        for (let zi = 0; zi < zones.length; zi++) {
          const z = zones[zi];
          if (d.x >= z.x && d.x <= z.x + z.w && d.y >= z.y && d.y <= z.y + z.h + 20) {
            const c = zoneSeatCount.get(zi) ?? { total: 0, live: 0 };
            c.total++;
            if (d.live) c.live++;
            zoneSeatCount.set(zi, c);
            break;
          }
        }
      }
      for (let zi = 0; zi < zones.length; zi++) {
        const z = zones[zi];
        ctx.fillStyle = z.tint;
        ctx.fillRect(z.x, z.y, z.w, z.h);
        ctx.strokeStyle = "#3d2b1f";
        ctx.lineWidth = 2;
        ctx.strokeRect(z.x + 1, z.y + 1, z.w - 2, z.h - 2);
        ctx.fillStyle = "#b09a72";
        ctx.font = '11px "VT323", monospace';
        ctx.fillText(z.label, z.x + 4, z.y + 11);
        const c = zoneSeatCount.get(zi);
        if (c) {
          ctx.fillStyle = c.live > 0 ? "#4ade80" : "#7d6a52";
          ctx.fillStyle = c.live > 0 ? "#4ade80" : "#7d6a52";
          ctx.textAlign = "right";
          ctx.fillText(`×${c.total}${c.live > 0 ? ` ▲${c.live}` : ""}`, z.x + z.w - 4, z.y + 11);
          ctx.textAlign = "left";
        }
        // zone divider light
        ctx.fillStyle = "rgba(249,115,22,0.25)";
        ctx.fillRect(z.x, z.y + 15, z.w, 1);
        if (!zonesWithSeats.has(zones.indexOf(z))) {
          ctx.fillStyle = "#5a4636";
          ctx.font = '11px "VT323", monospace';
          ctx.fillText("koltuk yok", z.x + 4, z.y + 28);
        }
      }

      // plants in corners
      const plant = (x: number, y: number) => {
        ctx.fillStyle = "#3d2b1f";
        ctx.fillRect(x - 2, y, 8, 5);
        ctx.fillStyle = PLANT;
        ctx.fillRect(x - 3, y - 6, 10, 6);
        ctx.fillStyle = "#4f9c4f";
        ctx.fillRect(x, y - 9, 4, 4);
      };
      plant(14, H - 12);
      plant(W - 22, H - 12);
      plant(14, 16);
      plant(W - 22, 16);

      // desks + agents
      for (const d of desks) {
        const bob = frame % 60 < 30 ? 0 : 1;
        const arm = d.live && frame % 30 < 15 ? 1 : 0;
        // desk slab
        ctx.fillStyle = DESK;
        ctx.fillRect(d.x - 2, d.y + 10, 26, 4);
        ctx.fillStyle = DESK_TOP;
        ctx.fillRect(d.x - 2, d.y + 10, 26, 1);
        // legs
        ctx.fillStyle = "#241611";
        ctx.fillRect(d.x, d.y + 14, 2, 4);
        ctx.fillRect(d.x + 20, d.y + 14, 2, 4);
        // monitor
        ctx.fillStyle = MONITOR;
        ctx.fillRect(d.x + 4, d.y - 2, 10, 7);
        ctx.fillStyle = d.live ? GLOW : "#223028";
        ctx.globalAlpha = d.live ? 0.85 : 0.35;
        ctx.fillRect(d.x + 5, d.y - 1, 8, 5);
        ctx.globalAlpha = 1;
        ctx.fillStyle = "#241611";
        ctx.fillRect(d.x + 7, d.y + 5, 4, 2);
        // agent sprite (16x16), tinted by family
        const sy = d.y - 12 + bob;
        paintSprite(ctx, d.x + 8, sy, d.seat.agent + d.seat.seatKey, 2);
        // live glow dot above the head
        if (d.live) {
          ctx.fillStyle = "#4ade80";
          ctx.fillRect(d.x + 14, sy - 2, 3, 2);
          ctx.fillStyle = "rgba(74,222,128,0.35)";
          ctx.fillRect(d.x + 12, sy - 4, 7, 5);
          // typing arms
          ctx.fillStyle = "#120a08";
          ctx.fillRect(d.x + 4 + arm * 6, sy + 12, 8, 2);
        } else {
          ctx.fillStyle = "rgba(13,8,7,0.32)";
          ctx.fillRect(d.x + 6, sy, 18, 16);
        }
      }

      // empty chairs when no seats
      if (desks.length === 0) {
        ctx.font = '13px "VT323", monospace';
        ctx.fillStyle = "#7d6a52";
        ctx.fillText("CLI YOK — bridge envanteri bekleniyor", 40, H / 2);
      }

      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);

    const onClick = (ev: MouseEvent) => {
      const rect = canvas.getBoundingClientRect();
      const mx = ((ev.clientX - rect.left) / rect.width) * W;
      const my = ((ev.clientY - rect.top) / rect.height) * H;
      for (const d of desksRef.current) {
        if (mx >= d.x - 4 && mx <= d.x + 26 && my >= d.y - 10 && my <= d.y + 20) {
          const live = liveKeys.has(d.seat.seatKey);
          if (live) {
            const match = useHudStore
              .getState()
              .sessions.find((s) => s.agent === d.seat.agent && (s.department === d.seat.department || !s.department));
            if (match) focusSession(match.id);
          }
          return;
        }
      }
    };
    canvas.addEventListener("click", onClick);
    return () => {
      cancelAnimationFrame(raf);
      canvas.removeEventListener("click", onClick);
    };
  }, [departments, agents, sessions, seats, liveKeys, deptSeatCount, focusSession]);

  return (
    <section className="deck-panel relative flex h-full min-h-0 flex-1 flex-col border border-line">
      <header className="deck-rail flex h-7 shrink-0 items-center gap-2 border-b border-line bg-bg-1/80 px-2">
        <span className="pixel-label">Ofis haritası</span>
        <span className="pixel-body ml-auto text-[13px] text-text-lo">
          {seats.length} koltuk · {sessions.length} canlı
        </span>
      </header>
      <div className="relative min-h-0 flex-1 overflow-hidden bg-[#160c09]">
        <canvas
          ref={canvasRef}
          width={W}
          height={H}
          className="pixelated h-full w-full object-fill"
          role="img"
          aria-label="Ofis haritası — canlı koltuklar yeşil yanar"
        />
      </div>
    </section>
  );
}
