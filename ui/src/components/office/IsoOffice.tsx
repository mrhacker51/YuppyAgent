"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Minus, Plus } from "lucide-react";
import { useHudStore } from "@/lib/store";
import { planSeats, type SeatAgent, type SeatDepartment, type SeatSpec } from "@/lib/autoTerminals";
import { accentFor, spriteBaseFor, useCharacters } from "@/lib/characters";
import { classifySpeechLine } from "@/lib/speech";
import { clampCamera, focusOn, MAX_ZOOM, MIN_ZOOM, zoomAt, type Camera } from "@/lib/officeCamera";
import {
  bodiesForSeats,
  CHAR_H,
  CHAR_W,
  DESK_H,
  DESK_W,
  layoutTeams,
  PROPS,
  roomBackground,
  SCENE_H,
  SCENE_W,
  seatPoint,
  WAYPOINTS,
  deskSprite,
  charSprite,
  facingFor,
  type Facing,
} from "@/lib/officeScene";
import { loadSprite } from "@/components/pixel/CharacterThumb";

/**
 * İzometrik ofis — the painting is real art, the state is real state.
 *
 * Room, desks and character bodies are the MIT-licensed sprite set from
 * W17ant/Claude-Office (see `public/office/NOTICE.md`); the fan-art skin from
 * that project is deliberately not shipped. Everything that moves is driven by
 * the live bridge: a seat with an open PTY sits at its desk and types, an idle
 * seat walks the aisles, and every bubble is a verbatim line that CLI printed.
 *
 * The canvas only paints. Placement, walking and facing rules live in
 * `@/lib/officeScene` and the camera clamps in `@/lib/officeCamera`, so both
 * are unit-tested without a browser.
 */

export default function IsoOffice() {
  const departments = useHudStore((s) => s.departments);
  const agents = useHudStore((s) => s.agents);
  const sessions = useHudStore((s) => s.sessions);
  const focusSession = useHudStore((s) => s.focusSession);
  const openTerminal = useHudStore((s) => s.openTerminal);
  const selectedDept = useHudStore((s) => s.selectedDept);
  const setSelectedDept = useHudStore((s) => s.setSelectedDept);
  const speech = useHudStore((s) => s.speech);
  const { map: characterMap } = useCharacters();

  /* Camera: zoom + pan. Kept in a ref (the animation loop reads it every
     frame) and mirrored into state only for the readout + button disabled
     states, so dragging never re-renders React 60 times a second. */
  const camRef = useRef<Camera>({ zoom: 1, x: 0, y: 0 });
  const [cam, setCam] = useState<Camera>({ zoom: 1, x: 0, y: 0 });
  const syncCam = () => setCam({ ...camRef.current });
  const clampCam = (c: Camera) => clampCamera(c, SCENE_W, SCENE_H);
  const zoomBy = (factor: number, ox?: number, oy?: number) => {
    camRef.current = zoomAt(camRef.current, factor, ox, oy, SCENE_W, SCENE_H);
    syncCam();
  };
  const resetCam = () => {
    camRef.current = { zoom: 1, x: 0, y: 0 };
    syncCam();
  };
  const zoomByRef = useRef(zoomBy);
  useEffect(() => {
    zoomByRef.current = zoomBy;
  });

  // Latest non-render state for the animation loop.
  const speechRef = useRef(speech);
  useEffect(() => {
    speechRef.current = speech;
  }, [speech]);
  const characterRef = useRef(characterMap);
  useEffect(() => {
    characterRef.current = characterMap;
  }, [characterMap]);

  const seats = useMemo(
    () => planSeats(departments as SeatDepartment[], agents as SeatAgent[]),
    [departments, agents],
  );

  // Which seat has a live PTY, and which session it is.
  const liveBySeat = useMemo(() => {
    const pool = [...sessions];
    const map = new Map<string, string>();
    for (const seat of seats) {
      const i = pool.findIndex(
        (s) => s.agent === seat.agent && (s.department === seat.department || !s.department),
      );
      if (i >= 0) {
        map.set(seat.seatKey, pool[i].id);
        pool.splice(i, 1);
      }
    }
    return map;
  }, [seats, sessions]);

  /**
   * One body per seat, alternating looks. Assigning by seat order (instead of
   * hashing per agent) is what keeps the floor visibly mixed: every Claude Code
   * seat would otherwise resolve to the same person.
   */
  const bodyBySeat = useMemo(() => bodiesForSeats(seats.map((s) => s.seatKey)), [seats]);

  const teamLayout = useMemo(() => {
    const shortName = (name: string) => {
      const t = name.toLowerCase();
      if (/software|yazılım|dev/.test(t)) return "YAZILIM";
      if (/review|code review/.test(t)) return "REVIEW";
      if (/research|araştırma/.test(t)) return "ARAŞTIRMA";
      if (/youtube|content/.test(t)) return "İÇERİK";
      if (/finans|finance/.test(t)) return "FİNANS";
      if (/custom/.test(t)) return "ÖZEL";
      return (name.trim().split(/\s+/)[0] ?? name).slice(0, 11).toUpperCase();
    };
    return layoutTeams(
      seats.map((s) => ({ department: s.department, label: s.label })),
      departments.map((d) => ({ id: d.id, name: d.name })),
      shortName,
    );
  }, [seats, departments]);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const blockCentresRef = useRef<Array<{ id: string; sx: number; sy: number }>>([]);

  /* Framing follows a real click, not the store value: the bridge restores a
     selected department on load, and the first paint must still show the whole
     room. Header chips and the in-panel legend both dispatch this event. */
  useEffect(() => {
    const onFocusTeam = (ev: Event) => {
      const id = (ev as CustomEvent<string>).detail;
      if (!id) {
        resetCam();
        return;
      }
      const centre = blockCentresRef.current.find((b) => b.id === id);
      if (!centre) return;
      camRef.current = focusOn(centre.sx, centre.sy, 1.9, SCENE_W, SCENE_H);
      syncCam();
    };
    window.addEventListener("yuppy:focus-team", onFocusTeam);
    return () => window.removeEventListener("yuppy:focus-team", onFocusTeam);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const blocks = teamLayout.blocks;
    blockCentresRef.current = blocks.map((b) => ({ id: b.id, sx: b.chipX, sy: b.chipY - 40 }));

    // Room background: the operator's real clock picks day or night art.
    const hour = new Date().getHours();
    const roomSrc = roomBackground(hour);
    loadSprite(roomSrc);

    type Mover = {
      seat: SeatSpec;
      sessionId?: string;
      live: boolean;
      x: number;
      y: number;
      gx: number;
      gy: number;
      wait: number;
      deskX: number;
      deskY: number;
      facing: Facing;
      walking: boolean;
      idleFor: number;
    };

    const movers: Mover[] = [];
    for (const block of blocks) {
      const blockSeats = seats.filter((s) => (s.department || "") === block.id);
      block.slots.forEach((slot, i) => {
        const seat = blockSeats[i];
        if (!seat) return;
        const p = seatPoint(slot);
        movers.push({
          seat,
          sessionId: liveBySeat.get(seat.seatKey),
          live: liveBySeat.has(seat.seatKey),
          x: p.x,
          y: p.y,
          gx: p.x,
          gy: p.y,
          wait: 0,
          deskX: p.x,
          deskY: p.y,
          facing: "front-left",
          walking: false,
          idleFor: 0,
        });
      });
    }

    const STEP = 62; // scene px per second

    const retarget = (m: Mover, now: number) => {
      if (m.live) {
        m.gx = m.deskX;
        m.gy = m.deskY;
        return;
      }
      const taken = movers.filter((o) => o !== m).map((o) => `${Math.round(o.gx)},${Math.round(o.gy)}`);
      const free = WAYPOINTS.filter((w) => !taken.includes(`${Math.round(w.x)},${Math.round(w.y)}`));
      const pool = free.length > 0 ? free : WAYPOINTS;
      const pick = pool[Math.floor((now * 0.7 + m.deskX * 3 + m.deskY * 5) % pool.length)];
      m.gx = pick.x;
      m.gy = pick.y;
    };

    const stepMovers = (dt: number, now: number) => {
      for (const m of movers) {
        // A seat that gained or lost a PTY retargets immediately.
        const liveNow = liveBySeat.has(m.seat.seatKey);
        if (liveNow !== m.live) {
          m.live = liveNow;
          m.wait = 0;
          retarget(m, now);
        }
        const dx = m.gx - m.x;
        const dy = m.gy - m.y;
        const dist = Math.hypot(dx, dy);
        if (dist < 1) {
          m.walking = false;
          m.idleFor += dt;
          if (m.wait <= 0) {
            m.wait = m.live ? 2.5 : 2.5 + ((m.deskX * 7 + m.deskY * 3) % 4);
            retarget(m, now);
          } else {
            m.wait -= dt;
          }
          continue;
        }
        m.walking = true;
        m.idleFor = 0;
        const step = Math.min(dist, STEP * dt);
        const nx = (dx / dist) * step;
        const ny = (dy / dist) * step;
        m.x += nx;
        m.y += ny;
        m.facing = facingFor(nx, ny, m.facing);
        m.wait = 0;
      }
    };

    /* The room art carries its own sky (day and night are separate paintings),
       so the clock alone decides which one the operator sees. No overlay: a
       repainted sky over baked lighting reads as a sticker. The other painting
       is NOT preloaded — a decoded 1508×1126 room costs ~7 MB and the switch
       only happens if the app stays open across 19:00. */

    let raf = 0;
    let last = performance.now();
    const start = performance.now();
    let frameW = 0;
    let frameH = 0;
    let dpr = 1;
    let fit = 1;
    let offX = 0;
    let offY = 0;

    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      dpr = Math.min(2, window.devicePixelRatio || 1);
      frameW = Math.max(1, Math.round(rect.width));
      frameH = Math.max(1, Math.round(rect.height));
      const bw = Math.round(frameW * dpr);
      const bh = Math.round(frameH * dpr);
      if (canvas.width !== bw || canvas.height !== bh) {
        canvas.width = bw;
        canvas.height = bh;
      }
      // Contain the 4:3 room inside the panel, then letterbox.
      fit = Math.min(frameW / SCENE_W, frameH / SCENE_H);
      offX = (frameW - SCENE_W * fit) / 2;
      offY = (frameH - SCENE_H * fit) / 2;
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);

    const hits: Array<{ sx: number; sy: number; id?: string; seat: SeatSpec }> = [];

    const drawSprite = (
      src: string,
      x: number,
      y: number,
      w: number,
      h: number,
      alpha = 1,
    ) => {
      const img = loadSprite(src);
      if (!img) return false;
      if (alpha < 1) ctx.globalAlpha = alpha;
      ctx.drawImage(img, x - w / 2, y - h, w, h);
      if (alpha < 1) ctx.globalAlpha = 1;
      return true;
    };

    const frame = () => {
      const now = performance.now();
      // The room is pixel art on a software-rendered 2D canvas: 30 fps is
      // visually identical to 60 and halves the per-frame paint cost. An
      // unfocused window drops to 12 fps — WebKitGTK does not always report
      // `document.hidden` when minimised, so without this a backgrounded
      // desk keeps a whole core warm.
      const budget = document.hidden ? 1000 : document.hasFocus() ? 33 : 83;
      if (now - last < budget) {
        raf = requestAnimationFrame(frame);
        return;
      }
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      const t = (now - start) / 1000;
      stepMovers(dt, t);

      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, canvas.width, canvas.height);

      const c = camRef.current;
      const s = fit * c.zoom;
      const tx = offX + fit * ((SCENE_W / 2) * (1 - c.zoom) + c.x);
      const ty = offY + fit * ((SCENE_H / 2) * (1 - c.zoom) + c.y);
      ctx.setTransform(dpr * s, 0, 0, dpr * s, dpr * tx, dpr * ty);

      // ── room art (day or night) ─────────────────────────────────────
      const room = loadSprite(roomSrc);
      if (room) ctx.drawImage(room, 0, 0, SCENE_W, SCENE_H);
      else {
        ctx.fillStyle = "#111a24";
        ctx.fillRect(0, 0, SCENE_W, SCENE_H);
      }

      // ── static props ────────────────────────────────────────────────
      for (const p of PROPS) drawSprite(p.src, p.x, p.y, p.w, p.h);

      // ── furniture + people, painted back to front ───────────────────
      type Item = { depth: number; draw: () => void };
      const items: Item[] = [];
      hits.length = 0;

      for (const block of blocks) {
        for (const slot of block.slots) {
          items.push({
            depth: slot.y,
            draw: () => {
              const d = deskSprite(slot.variant);
              drawSprite(d.src, slot.x, slot.y, DESK_W, DESK_H);
            },
          });
        }
      }

      for (const m of movers) {
        items.push({
          depth: m.y,
          draw: () => {
            const base = spriteBaseFor(
              m.seat.agent,
              characterRef.current,
              m.seat.seatKey,
              bodyBySeat[m.seat.seatKey],
            );
            const spr = charSprite(base, m.facing);
            // Ground contact shadow: without it a sprite on a detailed floor
            // reads as a sticker hovering above the wood.
            ctx.save();
            ctx.globalAlpha = 0.26;
            ctx.fillStyle = "#05080c";
            ctx.beginPath();
            ctx.ellipse(m.x, m.y + 0.5, 7, 2.3, 0, 0, Math.PI * 2);
            ctx.fill();
            ctx.restore();
            // A small step bob only while actually walking — never when idle,
            // so the motion always means movement.
            const bob = m.walking ? Math.abs(Math.sin(t * 7 + m.x * 0.35)) * 1.6 : 0;
            drawSprite(spr.src, m.x, m.y - bob, CHAR_W, CHAR_H);
            hits.push({ sx: m.x, sy: m.y - CHAR_H / 2, id: m.sessionId, seat: m.seat });
          },
        });
      }

      items.sort((a, b) => a.depth - b.depth);
      for (const item of items) item.draw();

      // ── live indicator + team chips, counter-scaled so they stay legible ──
      const k = 1 / Math.sqrt(Math.max(1, c.zoom));
      for (const m of movers) {
        if (!m.live) continue;
        const pulse = 0.55 + 0.45 * Math.sin(t * 4);
        ctx.save();
        ctx.translate(m.x, m.y - CHAR_H);
        ctx.scale(k, k);
        ctx.globalAlpha = pulse;
        ctx.fillStyle = "#4ade80";
        ctx.beginPath();
        ctx.arc(0, 0, 2.6, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = 1;
        ctx.restore();
      }

      // ── speech bubbles: the newest verbatim line each live agent printed ──
      const nowMs = Date.now();
      const recent: Array<{ m: Mover; line: string; ts: number }> = [];
      for (const m of movers) {
        if (!m.live) continue;
        let latest: { line: string; ts: number } | null = null;
        for (const sp of speechRef.current) {
          if (sp.agent !== m.seat.agent) continue;
          if (nowMs - sp.ts > 9000) continue;
          const kind = classifySpeechLine(sp.line).kind;
          if (kind !== "message" && kind !== "team") continue;
          if (!latest || sp.ts > latest.ts) latest = { line: sp.line, ts: sp.ts };
        }
        if (latest) recent.push({ m, line: latest.line, ts: latest.ts });
      }
      recent.sort((a, b) => b.ts - a.ts);

      const wrap = (text: string, max: number): string[] => {
        const words = text.split(/\s+/);
        const out: string[] = [];
        let cur = "";
        for (const w of words) {
          if (cur.length > 0 && cur.length + 1 + w.length > max) {
            out.push(cur);
            cur = w;
          } else {
            cur = cur.length > 0 ? `${cur} ${w}` : w;
          }
          if (out.length === 2) break;
        }
        if (cur && out.length < 2) out.push(cur);
        return out.slice(0, 2);
      };

      for (const b of recent.slice(0, 4)) {
        const age = nowMs - b.ts;
        const alpha = age < 6500 ? 1 : Math.max(0, 1 - (age - 6500) / 2500);
        if (alpha <= 0.02) continue;
        const lines = wrap(b.line, 30);
        if (lines.length === 0) continue;
        const accent = accentFor(b.m.seat.agent, characterRef.current);
        ctx.save();
        ctx.translate(b.m.x, b.m.y - CHAR_H);
        ctx.scale(k, k);
        ctx.font = "600 7px 'JetBrains Mono', monospace";
        const tw = Math.max(...lines.map((l) => ctx.measureText(l).width));
        const bw = Math.min(110, tw + 11);
        const bh = lines.length * 8 + 8;
        ctx.globalAlpha = alpha;
        ctx.fillStyle = "rgba(7, 11, 16, 0.94)";
        ctx.beginPath();
        ctx.moveTo(-3.5, -1);
        ctx.lineTo(3.5, -1);
        ctx.lineTo(0, 4);
        ctx.closePath();
        ctx.fill();
        ctx.beginPath();
        ctx.roundRect(-bw / 2, -bh - 1, bw, bh, 3);
        ctx.fill();
        ctx.strokeStyle = `${accent}99`;
        ctx.lineWidth = 0.9;
        ctx.stroke();
        ctx.fillStyle = accent;
        ctx.fillRect(-bw / 2 + 1, -bh + 2, 1.6, bh - 6);
        ctx.fillStyle = "#dfe8f2";
        ctx.textAlign = "left";
        lines.forEach((l, i) => ctx.fillText(l, -bw / 2 + 5, -bh + 7 + i * 8));
        ctx.globalAlpha = 1;
        ctx.restore();
      }

      // ── vignette so the room sits in the panel ─────────────────────
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      const vg = ctx.createRadialGradient(
        canvas.width / 2,
        canvas.height / 2,
        Math.min(canvas.width, canvas.height) * 0.28,
        canvas.width / 2,
        canvas.height / 2,
        Math.max(canvas.width, canvas.height) * 0.72,
      );
      vg.addColorStop(0, "rgba(0,0,0,0)");
      vg.addColorStop(1, "rgba(3,7,11,0.42)");
      ctx.fillStyle = vg;
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      if (running) raf = requestAnimationFrame(frame);
    };

    /* The office is a continuous animation. It must not burn a frame budget
       while the operator is in another module, another tab or the window is
       minimised. */
    let running = true;
    const play = () => {
      if (running) return;
      running = true;
      last = performance.now();
      raf = requestAnimationFrame(frame);
    };
    const pause = () => {
      if (!running) return;
      running = false;
      cancelAnimationFrame(raf);
    };
    const onVisibility = () => (document.hidden ? pause() : play());
    document.addEventListener("visibilitychange", onVisibility);
    const io =
      typeof IntersectionObserver !== "undefined"
        ? new IntersectionObserver(
            (entries) => {
              const visible = entries.some((e) => e.isIntersecting);
              if (visible && !document.hidden) play();
              else pause();
            },
            { threshold: 0.05 },
          )
        : null;
    io?.observe(canvas);
    raf = requestAnimationFrame(frame);

    /* ── input: click a seat, wheel to zoom, drag to pan ─────────────── */
    let dragMoved = false;
    let dragging = false;
    let lastPt = { x: 0, y: 0 };

    const toScene = (ev: MouseEvent | PointerEvent) => {
      const rect = canvas.getBoundingClientRect();
      const px = ev.clientX - rect.left;
      const py = ev.clientY - rect.top;
      const c = camRef.current;
      // Inverse of the render transform above.
      return {
        x: (px - offX - fit * ((SCENE_W / 2) * (1 - c.zoom) + c.x)) / (fit * c.zoom),
        y: (py - offY - fit * ((SCENE_H / 2) * (1 - c.zoom) + c.y)) / (fit * c.zoom),
      };
    };

    const pickHit = (mx: number, my: number) => {
      let best: (typeof hits)[number] | null = null;
      let bestD = Infinity;
      for (const h of hits) {
        const dx = mx - h.sx;
        const dy = my - h.sy;
        const d = dx * dx + dy * dy;
        if (d < 24 * 24 && d < bestD) {
          best = h;
          bestD = d;
        }
      }
      return best;
    };

    const onClick = (ev: MouseEvent) => {
      if (dragMoved) return;
      const { x, y } = toScene(ev);
      const best = pickHit(x, y);
      if (!best) return;
      if (best.id) focusSession(best.id);
      else openTerminal(best.seat.agent, best.seat.label, best.seat.department);
    };
    const onWheel = (ev: WheelEvent) => {
      ev.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const c = camRef.current;
      const ox = (ev.clientX - rect.left - offX) / fit - (SCENE_W / 2) * (1 - c.zoom) - c.x;
      const oy = (ev.clientY - rect.top - offY) / fit - (SCENE_H / 2) * (1 - c.zoom) - c.y;
      zoomByRef.current(ev.deltaY < 0 ? 1.12 : 1 / 1.12, ox, oy);
    };
    const onDown = (ev: PointerEvent) => {
      dragging = true;
      dragMoved = false;
      lastPt = { x: ev.clientX, y: ev.clientY };
      canvas.style.cursor = "grabbing";
      canvas.setPointerCapture?.(ev.pointerId);
    };
    const onMove = (ev: PointerEvent) => {
      if (!dragging) {
        const { x, y } = toScene(ev);
        canvas.style.cursor = pickHit(x, y)
          ? "pointer"
          : camRef.current.zoom > 1.01
            ? "grab"
            : "default";
        return;
      }
      const dx = (ev.clientX - lastPt.x) / fit;
      const dy = (ev.clientY - lastPt.y) / fit;
      if (Math.abs(dx) + Math.abs(dy) > 1.5) dragMoved = true;
      lastPt = { x: ev.clientX, y: ev.clientY };
      const cur = camRef.current;
      camRef.current = clampCam({
        ...cur,
        x: cur.x + dx / cur.zoom,
        y: cur.y + dy / cur.zoom,
      });
    };
    const onUp = () => {
      dragging = false;
      canvas.style.cursor = camRef.current.zoom > 1.01 ? "grab" : "default";
      syncCam();
    };

    canvas.addEventListener("wheel", onWheel, { passive: false });
    canvas.addEventListener("pointerdown", onDown);
    canvas.addEventListener("pointermove", onMove);
    canvas.addEventListener("pointerup", onUp);
    canvas.addEventListener("pointercancel", onUp);
    canvas.addEventListener("click", onClick);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      document.removeEventListener("visibilitychange", onVisibility);
      io?.disconnect();
      canvas.removeEventListener("wheel", onWheel);
      canvas.removeEventListener("pointerdown", onDown);
      canvas.removeEventListener("pointermove", onMove);
      canvas.removeEventListener("pointerup", onUp);
      canvas.removeEventListener("pointercancel", onUp);
      canvas.removeEventListener("click", onClick);
    };
  }, [teamLayout, liveBySeat, seats, bodyBySeat, focusSession, openTerminal]);

  const liveCount = seats.filter((s) => liveBySeat.has(s.seatKey)).length;
  const shown = teamLayout.blocks.reduce((n, b) => n + b.slots.length, 0);

  return (
    <section className="deck-panel flex min-h-0 flex-1 flex-col overflow-hidden">
      <header className="deck-rail flex h-8 shrink-0 items-center gap-2 border-b border-line px-2.5">
        <span className="pixel-label">Ofis</span>
        <span className="rounded-sm border border-line px-1 py-px font-mono text-[9px] uppercase tracking-wider text-text-lo">
          izometrik
        </span>
        {selectedDept && (
          <span className="font-mono text-[9px] uppercase tracking-wider text-accent/80">
            {departments.find((d) => d.id === selectedDept)?.name}
          </span>
        )}
        <span className="ml-auto flex items-center gap-1.5 font-mono text-[9px] tabular-nums text-text-lo">
          <span className="flex items-center gap-1">
            <span className="size-1.5 rounded-full bg-ok" aria-hidden />
            {liveCount} canlı
          </span>
          <span className="text-line">/</span>
          <span title={shown < seats.length ? `${seats.length} koltuktan ${shown} tanesi odada` : undefined}>
            {shown} masa
          </span>
          {teamLayout.overflow > 0 && (
            <span className="text-warn" title="Odaya sığmayan koltuklar terminal matrisinde kalır">
              +{teamLayout.overflow}
            </span>
          )}
          <span className="ml-1 flex items-center rounded-sm border border-line">
            <button
              type="button"
              onClick={() => zoomBy(1 / 1.25)}
              disabled={cam.zoom <= MIN_ZOOM + 0.001}
              title="Uzaklaştır"
              aria-label="Haritayı uzaklaştır"
              className="grid size-4 place-items-center text-text-lo transition-colors hover:bg-bg-2 hover:text-text-hi disabled:opacity-30"
            >
              <Minus size={9} aria-hidden />
            </button>
            <button
              type="button"
              onClick={resetCam}
              title="Yakınlaştırmayı sıfırla"
              aria-label={`Yakınlaştırma ${Math.round(cam.zoom * 100)}% — sıfırla`}
              className="w-9 border-x border-line text-center text-[8.5px] tabular-nums text-text-mid transition-colors hover:bg-bg-2 hover:text-text-hi"
            >
              {Math.round(cam.zoom * 100)}%
            </button>
            <button
              type="button"
              onClick={() => zoomBy(1.25)}
              disabled={cam.zoom >= MAX_ZOOM - 0.001}
              title="Yakınlaştır"
              aria-label="Haritayı yakınlaştır"
              className="grid size-4 place-items-center text-text-lo transition-colors hover:bg-bg-2 hover:text-text-hi disabled:opacity-30"
            >
              <Plus size={9} aria-hidden />
            </button>
          </span>
        </span>
      </header>

      <div className="relative min-h-0 flex-1 overflow-hidden bg-[#0b1118]">
        <canvas
          ref={canvasRef}
          className="block h-full w-full"
          role="img"
          aria-label="İzometrik ofis — her masa bir koltuk, canlı ajanlar masasında çalışıyor"
        />
        {/* Team legend: real counts, clickable to frame that team's desks. */}
        {teamLayout.blocks.length > 0 && (
          <div className="pointer-events-none absolute inset-x-1 bottom-1 flex items-center gap-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            {teamLayout.blocks.map((block) => {
              const live = seats.filter(
                (s) => (s.department || "") === block.id && liveBySeat.has(s.seatKey),
              ).length;
              const active = selectedDept === block.id;
              return (
                <button
                  key={block.id || "all"}
                  type="button"
                  onClick={() => {
                    const next = active ? "" : block.id;
                    setSelectedDept(next);
                    window.dispatchEvent(new CustomEvent("yuppy:focus-team", { detail: next }));
                  }}
                  title={`${block.name} — ${live}/${block.seats} canlı · odağa al`}
                  className={`pointer-events-auto flex shrink-0 items-center gap-1 rounded-sm border px-1.5 py-0.5 font-mono text-[8px] uppercase tracking-wider backdrop-blur-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/60 ${
                    active
                      ? "border-accent/60 bg-accent/15 text-accent"
                      : "border-line/70 bg-bg-0/75 text-text-lo hover:border-line-strong hover:text-text-mid"
                  }`}
                >
                  <span
                    className={`size-1 rounded-full ${live > 0 ? "bg-ok" : "bg-text-lo/40"}`}
                    aria-hidden
                  />
                  {block.label}
                  <span className={live > 0 ? "text-ok/90" : "text-text-lo/70"}>
                    {live}/{block.seats}
                  </span>
                </button>
              );
            })}

          </div>
        )}
      </div>
    </section>
  );
}
