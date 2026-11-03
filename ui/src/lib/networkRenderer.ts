/**
 * Canvas 2D renderer for the AgentSpace network map.
 *
 * One render loop, delta-time based, no per-frame React state. The renderer
 * only paints what the graph model says is real: departments, detected
 * executors, live PTY sessions, scheduler states and conflicts. Ambient dust,
 * radar sweeps and pulses are decoration around that data, never a source of
 * truth. Effect budgets come from `lib/effects.ts`.
 */
import type { ResolvedEffects } from "./effects";
import {
  bezierControl,
  hash01,
  pointAt,
  type Graph,
  type GraphEdge,
  type GraphNode,
  type Vec,
} from "./networkGraph";

export interface Camera {
  x: number;
  y: number;
  zoom: number;
}

export interface Viewport {
  w: number;
  h: number;
  dpr: number;
}

interface VisualNode {
  x: number;
  y: number;
  /** 0..1 spawn animation (node morph-in). */
  born: number;
}

interface Flow {
  edgeId: string;
  t: number;
  dir: 1 | -1;
  speed: number;
  size: number;
  color: string;
  /** Ambient flows loop while the edge stays active. */
  loop: boolean;
  age: number;
  ttl: number;
}

interface Spark {
  x: number;
  y: number;
  vx: number;
  vy: number;
  age: number;
  ttl: number;
  color: string;
  size: number;
}

interface Ring {
  x: number;
  y: number;
  age: number;
  ttl: number;
  color: string;
  maxR: number;
}

interface Pulse {
  nodeId: string;
  age: number;
  ttl: number;
  color: string;
}

interface Dust {
  x: number;
  y: number;
  r: number;
  vx: number;
  vy: number;
  layer: number;
}

interface EdgeGeom {
  a: Vec;
  c: Vec;
  b: Vec;
  color: string;
}

export interface Fx {
  nodes: Map<string, VisualNode>;
  flows: Flow[];
  sparks: Spark[];
  rings: Ring[];
  pulses: Pulse[];
  edgeBorn: Map<string, number>;
  /** Last drawn geometry per edge, used to fade removed relationships out. */
  edgeGeom: Map<string, EdgeGeom>;
  /** Recently removed edges, fading out (dynamic connection removal). */
  dying: Map<string, { a: Vec; c: Vec; b: Vec; born: number; color: string }>;
  activity: Map<string, number>;
  corePulse: number;
  coreError: number;
  spin: number;
  radar: number;
  glitchUntil: number;
  dust: Dust[];
  dustFor: number;
  time: number;
}

export function createFx(): Fx {
  return {
    nodes: new Map(),
    flows: [],
    sparks: [],
    rings: [],
    pulses: [],
    edgeBorn: new Map(),
    edgeGeom: new Map(),
    dying: new Map(),
    activity: new Map(),
    corePulse: 0,
    coreError: 0,
    spin: 0,
    radar: 0,
    glitchUntil: 0,
    dust: [],
    dustFor: 0,
    time: 0,
  };
}

/* ── palette (matches globals.css tokens) ─────────────────────────────── */
export const COLORS = {
  bg0: "#08090a",
  accent: "#f97316",
  accentDim: "rgba(249, 115, 22, 0.35)",
  cyan: "#22d3ee",
  cyanDim: "rgba(34, 211, 238, 0.32)",
  violet: "#a78bfa",
  ok: "#22c55e",
  warn: "#eab308",
  danger: "#ef4444",
  textHi: "rgba(231, 229, 228, 0.92)",
  textMid: "rgba(168, 162, 158, 0.9)",
  textLo: "rgba(120, 113, 108, 0.9)",
  line: "rgba(231, 229, 228, 0.09)",
};

export function nodeColor(node: GraphNode): string {
  switch (node.status) {
    case "live":
      return COLORS.ok;
    case "busy":
      return COLORS.accent;
    case "completed":
      return COLORS.cyan;
    case "failed":
      return COLORS.danger;
    case "offline":
    case "disabled":
      return "rgba(120, 113, 108, 0.55)";
    case "idle":
      return COLORS.cyanDim;
    default:
      return COLORS.textMid;
  }
}

function edgeColor(edge: GraphEdge): string {
  if (edge.kind === "conflict") return COLORS.danger;
  if (edge.kind === "task") return edge.active ? COLORS.ok : COLORS.accentDim;
  if (edge.kind === "seat") return edge.active ? COLORS.cyanDim : "rgba(34, 211, 238, 0.14)";
  return edge.active ? "rgba(249, 115, 22, 0.22)" : "rgba(231, 229, 228, 0.10)";
}

/* ── camera helpers ───────────────────────────────────────────────────── */

export function resetCamera(view: Viewport): Camera {
  const zoom = Math.max(0.5, Math.min(1.35, Math.min(view.w, view.h) / 560));
  return { x: 0, y: 0, zoom };
}

export function worldToScreen(camera: Camera, view: Viewport, p: Vec): Vec {
  return {
    x: (p.x - camera.x) * camera.zoom + view.w / 2,
    y: (p.y - camera.y) * camera.zoom + view.h / 2,
  };
}

export function screenToWorld(camera: Camera, view: Viewport, sx: number, sy: number): Vec {
  return {
    x: (sx - view.w / 2) / camera.zoom + camera.x,
    y: (sy - view.h / 2) / camera.zoom + camera.y,
  };
}

export function nodeRadius(node: GraphNode): number {
  return node.kind === "department" ? 19 : node.kind === "agent" ? 11 : 24;
}

export function hitTest(
  camera: Camera,
  view: Viewport,
  fx: Fx,
  graph: Graph,
  sx: number,
  sy: number,
): GraphNode | null {
  let best: GraphNode | null = null;
  let bestD = Infinity;
  for (const node of graph.nodes) {
    const visual = fx.nodes.get(node.id);
    if (!visual) continue;
    const p = worldToScreen(camera, view, { x: visual.x, y: visual.y });
    const d = Math.hypot(p.x - sx, p.y - sy);
    const r = nodeRadius(node) * camera.zoom + 6;
    if (d <= r && d < bestD) {
      best = node;
      bestD = d;
    }
  }
  return best;
}

/* ── event-driven FX helpers (called from React effects) ──────────────── */

export function pulseNode(fx: Fx, nodeId: string, color: string, ttl = 0.9): void {
  if (fx.pulses.length > 40) fx.pulses.shift();
  fx.pulses.push({ nodeId, age: 0, ttl, color });
}

export function sonar(fx: Fx, color = COLORS.accent, maxR = 220, ttl = 1.4): void {
  const core = fx.nodes.get("core");
  if (fx.rings.length > 12) fx.rings.shift();
  fx.rings.push({ x: core?.x ?? 0, y: core?.y ?? 0, age: 0, ttl, color, maxR });
}

export function burst(fx: Fx, nodeId: string, color: string, count = 10): void {
  const visual = fx.nodes.get(nodeId);
  if (!visual) return;
  const n = Math.min(26, count);
  for (let i = 0; i < n; i++) {
    const angle = (i / n) * Math.PI * 2 + Math.random() * 0.4;
    const speed = 26 + Math.random() * 60;
    fx.sparks.push({
      x: visual.x,
      y: visual.y,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      age: 0,
      ttl: 0.5 + Math.random() * 0.5,
      color,
      size: 1 + Math.random() * 1.6,
    });
  }
  if (fx.sparks.length > 260) fx.sparks.splice(0, fx.sparks.length - 260);
}

export function bumpCore(fx: Fx, amount: number): void {
  fx.corePulse = Math.min(1.6, fx.corePulse + amount);
}

export function glitch(fx: Fx, now: number, ms = 420): void {
  fx.glitchUntil = Math.max(fx.glitchUntil, now + ms);
}

/* ── frame ────────────────────────────────────────────────────────────── */

const TAU = Math.PI * 2;

function ease(current: number, target: number, dt: number, rate = 9): number {
  return current + (target - current) * Math.min(1, dt * rate);
}

function initDust(fx: Fx, count: number): void {
  fx.dust = [];
  for (let i = 0; i < count; i++) {
    fx.dust.push({
      x: Math.random(),
      y: Math.random(),
      r: 0.4 + Math.random() * 1.4,
      vx: (Math.random() - 0.5) * 0.006,
      vy: -0.002 - Math.random() * 0.01,
      layer: Math.random() < 0.5 ? 0.55 : 1,
    });
  }
  fx.dustFor = count;
}

function drawGrid(ctx: CanvasRenderingContext2D, view: Viewport, camera: Camera): void {
  const step = 64;
  const tl = screenToWorld(camera, view, 0, 0);
  const br = screenToWorld(camera, view, view.w, view.h);
  const x0 = Math.floor(tl.x / step) * step;
  const y0 = Math.floor(tl.y / step) * step;
  ctx.lineWidth = 1;
  ctx.strokeStyle = "rgba(231, 229, 228, 0.035)";
  ctx.beginPath();
  for (let x = x0; x <= br.x; x += step) {
    const p = worldToScreen(camera, view, { x, y: 0 });
    ctx.moveTo(Math.round(p.x) + 0.5, 0);
    ctx.lineTo(Math.round(p.x) + 0.5, view.h);
  }
  for (let y = y0; y <= br.y; y += step) {
    const p = worldToScreen(camera, view, { x: 0, y });
    ctx.moveTo(0, Math.round(p.y) + 0.5);
    ctx.lineTo(view.w, Math.round(p.y) + 0.5);
  }
  ctx.stroke();

  // Holographic rings around the core (concentric HUD scale).
  const core = worldToScreen(camera, view, { x: 0, y: 0 });
  ctx.strokeStyle = "rgba(249, 115, 22, 0.07)";
  for (const r of [90, 150, 210, 272]) {
    ctx.beginPath();
    ctx.arc(core.x, core.y, r * camera.zoom, 0, TAU);
    ctx.stroke();
  }
}

function drawDust(
  ctx: CanvasRenderingContext2D,
  view: Viewport,
  camera: Camera,
  fx: Fx,
  resolved: ResolvedEffects,
  dt: number,
  staticMode: boolean,
): void {
  if (fx.dust.length !== resolved.dustCount) initDust(fx, resolved.dustCount);
  const drift = staticMode ? 0 : dt * resolved.speed;
  for (const d of fx.dust) {
    d.x += d.vx * drift;
    d.y += d.vy * drift;
    if (d.y < -0.02) {
      d.y = 1.02;
      d.x = Math.random();
    }
    if (d.x < -0.02) d.x = 1.02;
    if (d.x > 1.02) d.x = -0.02;
    // Parallax: nearer layers move with the camera, far ones barely.
    const px = d.x * view.w - camera.x * camera.zoom * 0.25 * d.layer;
    const py = d.y * view.h - camera.y * camera.zoom * 0.25 * d.layer;
    const sx = ((px % view.w) + view.w) % view.w;
    const sy = ((py % view.h) + view.h) % view.h;
    ctx.beginPath();
    ctx.fillStyle =
      d.layer > 0.9 ? `rgba(168, 197, 216, ${0.10 + 0.10 * resolved.density})` : "rgba(120, 140, 160, 0.10)";
    ctx.arc(sx, sy, d.r * (0.8 + d.layer * 0.3), 0, TAU);
    ctx.fill();
  }
}

function drawEdges(
  ctx: CanvasRenderingContext2D,
  view: Viewport,
  camera: Camera,
  graph: Graph,
  fx: Fx,
  now: number,
  staticMode: boolean,
): void {
  for (const edge of graph.edges) {
    const from = fx.nodes.get(edge.from);
    const to = fx.nodes.get(edge.to);
    if (!from || !to) continue;
    const a = { x: from.x, y: from.y };
    const b = { x: to.x, y: to.y };
    const curvature = (hash01(edge.id) - 0.5) * 0.34;
    const c = bezierControl(a, b, curvature);
    const color = edgeColor(edge);

    let progress = 1;
    if (!staticMode && fx.edgeBorn) {
      const born = fx.edgeBorn.get(edge.id);
      if (born != null) progress = Math.min(1, (now - born) / 520);
    }

    const aS = worldToScreen(camera, view, a);

    // Remember the geometry for a later fade-out if this edge disappears.
    fx.edgeGeom.set(edge.id, { a, b, c, color });

    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = edge.kind === "task" && edge.active ? 1.6 : 1;
    ctx.globalAlpha = edge.active ? 0.95 : 0.8;
    ctx.beginPath();
    ctx.moveTo(aS.x, aS.y);
    // Sample the bezier so the drawn reveal follows the true curve.
    const segments = 26;
    const upTo = Math.max(1, Math.round(segments * (staticMode ? 1 : progress)));
    for (let i = 1; i <= upTo; i++) {
      const t = (i / segments) * (staticMode ? 1 : progress);
      const p = bezierControl(a, b, curvature);
      const pt = pointAt(a, p, b, t);
      const s = worldToScreen(camera, view, pt);
      ctx.lineTo(s.x, s.y);
    }
    ctx.stroke();
    // Edge glow on active flows.
    if (edge.active && edge.kind === "task") {
      ctx.globalAlpha = 0.16;
      ctx.lineWidth = 4;
      ctx.stroke();
    }
    ctx.restore();
  }

  for (const [id, dead] of fx.dying) {
    const alpha = Math.max(0, 1 - (now - dead.born) / 420);
    if (alpha <= 0) {
      fx.dying.delete(id);
      fx.edgeBorn.delete(id);
      continue;
    }
    const aS = worldToScreen(camera, view, dead.a);
    const cS = worldToScreen(camera, view, dead.c);
    const bS = worldToScreen(camera, view, dead.b);
    ctx.save();
    ctx.globalAlpha = alpha * 0.6;
    ctx.strokeStyle = dead.color;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(aS.x, aS.y);
    ctx.quadraticCurveTo(cS.x, cS.y, bS.x, bS.y);
    ctx.stroke();
    ctx.restore();
  }
}

function drawFlows(
  ctx: CanvasRenderingContext2D,
  view: Viewport,
  camera: Camera,
  graph: Graph,
  fx: Fx,
): void {
  const byId = new Map(graph.edges.map((e) => [e.id, e]));
  for (const flow of fx.flows) {
    const edge = byId.get(flow.edgeId);
    if (!edge) continue;
    const from = fx.nodes.get(edge.from);
    const to = fx.nodes.get(edge.to);
    if (!from || !to) continue;
    const a = { x: from.x, y: from.y };
    const b = { x: to.x, y: to.y };
    const c = bezierControl(a, b, (hash01(edge.id) - 0.5) * 0.34);
    const t = Math.min(1, Math.max(0, flow.t));
    const p = pointAt(a, c, b, t);
    const trailT = Math.min(1, Math.max(0, t - flow.dir * 0.07));
    const trail = pointAt(a, c, b, trailT);
    const pS = worldToScreen(camera, view, p);
    const tS = worldToScreen(camera, view, trail);
    ctx.save();
    ctx.strokeStyle = flow.color;
    ctx.globalAlpha = 0.5;
    ctx.lineWidth = Math.max(0.8, flow.size * 0.7);
    ctx.beginPath();
    ctx.moveTo(tS.x, tS.y);
    ctx.lineTo(pS.x, pS.y);
    ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.fillStyle = flow.color;
    ctx.shadowColor = flow.color;
    ctx.shadowBlur = 8;
    ctx.beginPath();
    ctx.arc(pS.x, pS.y, Math.max(0.8, flow.size), 0, TAU);
    ctx.fill();
    ctx.restore();
  }
}

function statusRing(
  ctx: CanvasRenderingContext2D,
  node: GraphNode,
  x: number,
  y: number,
  r: number,
  now: number,
  fx: Fx,
  glow: boolean,
): void {
  const color = nodeColor(node);
  const selected = node.selected;
  ctx.save();
  if (glow) {
    ctx.shadowColor = color;
    ctx.shadowBlur = selected ? 18 : 9;
  }
  ctx.strokeStyle = color;
  ctx.lineWidth = selected ? 2 : 1.2;
  ctx.beginPath();
  ctx.arc(x, y, r, 0, TAU);
  ctx.stroke();
  ctx.restore();

  if (node.status === "failed" || node.status === "disabled") {
    ctx.save();
    ctx.strokeStyle = color;
    ctx.globalAlpha = 0.5;
    ctx.setLineDash([2, 3]);
    ctx.beginPath();
    ctx.arc(x, y, r + 3.5, 0, TAU);
    ctx.stroke();
    ctx.restore();
  }

  if (node.status === "live" || node.status === "busy") {
    const base = node.status === "busy" ? 2.4 : 1.2;
    const activity = fx.activity.get(node.id) ?? 0;
    const speed = base + activity * 2;
    const start = fx.spin * speed;
    ctx.save();
    ctx.strokeStyle = color;
    ctx.globalAlpha = 0.75;
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.arc(x, y, r + 4, start, start + 1.5);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(x, y, r + 4, start + Math.PI, start + Math.PI + 1.5);
    ctx.stroke();
    ctx.restore();
  }

  if (node.status === "failed") {
    const pulse = 0.5 + 0.5 * Math.sin(now / 180);
    ctx.save();
    ctx.globalAlpha = 0.25 + 0.35 * pulse;
    ctx.strokeStyle = COLORS.danger;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(x, y, r + 8 + pulse * 4, 0, TAU);
    ctx.stroke();
    ctx.restore();
  }
}

function drawNodes(
  ctx: CanvasRenderingContext2D,
  view: Viewport,
  camera: Camera,
  graph: Graph,
  fx: Fx,
  resolved: ResolvedEffects,
  now: number,
  hovered: string | null,
): void {
  for (const node of graph.nodes) {
    if (node.kind === "core") continue;
    const visual = fx.nodes.get(node.id);
    if (!visual) continue;
    const p = worldToScreen(camera, view, { x: visual.x, y: visual.y });
    const scale = 0.75 + 0.25 * visual.born;
    const r = nodeRadius(node) * camera.zoom * scale;
    if (r < 0.5) continue;
    const color = nodeColor(node);

    // Selection / hover halo.
    if (node.selected || hovered === node.id) {
      const halo = ctx.createRadialGradient(p.x, p.y, r * 0.4, p.x, p.y, r * 2.6);
      halo.addColorStop(0, node.selected ? "rgba(249, 115, 22, 0.20)" : "rgba(231, 229, 228, 0.10)");
      halo.addColorStop(1, "rgba(0,0,0,0)");
      ctx.fillStyle = halo;
      ctx.beginPath();
      ctx.arc(p.x, p.y, r * 2.6, 0, TAU);
      ctx.fill();
    }

    // Body.
    ctx.save();
    const body = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, r);
    body.addColorStop(0, "rgba(13, 14, 16, 0.98)");
    body.addColorStop(1, "rgba(8, 9, 10, 0.96)");
    ctx.fillStyle = body;
    ctx.beginPath();
    ctx.arc(p.x, p.y, r, 0, TAU);
    ctx.fill();
    ctx.restore();

    statusRing(ctx, node, p.x, p.y, r, now, fx, resolved.glow && resolved.nodeGlow);

    // Inner status dot (breathing when working).
    const breathe =
      resolved.nodeGlow && !resolved.reducedMotion
        ? 0.75 + 0.25 * Math.sin(now / 520 + hash01(node.id) * TAU)
        : 1;
    ctx.save();
    ctx.fillStyle = color;
    ctx.globalAlpha = 0.9;
    ctx.beginPath();
    ctx.arc(p.x, p.y, Math.max(1.2, r * 0.28 * breathe), 0, TAU);
    ctx.fill();
    ctx.restore();

    // Labels (drawn at constant-ish size relative to the zoom).
    const labelPx = Math.max(7, 9.5 * Math.min(1.2, camera.zoom));
    ctx.save();
    ctx.textAlign = "center";
    ctx.fillStyle = node.selected ? COLORS.accent : COLORS.textHi;
    ctx.font = `${node.kind === "department" ? 600 : 500} ${labelPx}px ui-monospace, monospace`;
    ctx.fillText(node.label, p.x, p.y + r + labelPx + 4);
    ctx.font = `${Math.max(6, labelPx * 0.78)}px ui-monospace, monospace`;
    ctx.fillStyle = node.selected ? "rgba(249, 115, 22, 0.75)" : COLORS.textLo;
    ctx.fillText(node.sub, p.x, p.y + r + labelPx * 2 + 6);
    ctx.restore();
  }
}

function drawCore(
  ctx: CanvasRenderingContext2D,
  view: Viewport,
  camera: Camera,
  graph: Graph,
  fx: Fx,
  resolved: ResolvedEffects,
  now: number,
  status: string,
): void {
  const visual = fx.nodes.get("core");
  if (!visual) return;
  const p = worldToScreen(camera, view, { x: visual.x, y: visual.y });
  const zoom = camera.zoom;
  const animate = resolved.core && !resolved.reducedMotion;
  const pulse = animate ? 1 + 0.05 * Math.sin(now / 900) + Math.min(0.45, fx.corePulse * 0.25) : 1;
  const errorMix = Math.min(1, fx.coreError);
  const coreColor = errorMix > 0.05 ? COLORS.danger : COLORS.accent;

  // Atmospheric glow (bloom budget).
  if (resolved.glow && resolved.core) {
    const glowR = (86 + 40 * Math.min(1, fx.corePulse)) * zoom * pulse;
    const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, glowR);
    const alpha = (0.10 + 0.22 * resolved.bloom) * (errorMix > 0.05 ? 1 : 1);
    g.addColorStop(0, errorMix > 0.05 ? `rgba(239, 68, 68, ${alpha})` : `rgba(249, 115, 22, ${alpha})`);
    g.addColorStop(0.45, errorMix > 0.05 ? "rgba(239, 68, 68, 0.05)" : "rgba(249, 115, 22, 0.05)");
    g.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(p.x, p.y, glowR, 0, TAU);
    ctx.fill();
  }

  // Radar sweep (real activity dial, not a fabricated metric).
  if (resolved.hud && resolved.core && !resolved.reducedMotion) {
    const radius = 96 * zoom;
    const angle = fx.radar;
    const conic = ctx as CanvasRenderingContext2D & {
      createConicGradient?: (startAngle: number, x: number, y: number) => CanvasGradient;
    };
    const sweep = conic.createConicGradient?.(angle, p.x, p.y);
    if (sweep) {
      sweep.addColorStop(0, "rgba(249, 115, 22, 0.16)");
      sweep.addColorStop(0.12, "rgba(249, 115, 22, 0)");
      sweep.addColorStop(1, "rgba(249, 115, 22, 0)");
      ctx.save();
      ctx.fillStyle = sweep;
      ctx.beginPath();
      ctx.arc(p.x, p.y, radius, 0, TAU);
      ctx.fill();
      ctx.restore();
    }
  }

  // Rotating HUD rings + orbital elements.
  const rings = [
    { r: 34, speed: 1, color: COLORS.accent, dash: 0.55, width: 1.4 },
    { r: 44, speed: -0.65, color: COLORS.cyan, dash: 0.35, width: 1 },
    { r: 56, speed: 0.4, color: COLORS.violet, dash: 0.22, width: 1 },
  ];
  if (resolved.core) {
    for (const ring of rings) {
      const rr = ring.r * zoom;
      ctx.save();
      ctx.strokeStyle = ring.color;
      ctx.globalAlpha = 0.55;
      ctx.lineWidth = ring.width;
      ctx.setLineDash([rr * ring.dash, rr * 0.9]);
      ctx.lineDashOffset = -fx.spin * 20 * ring.speed * (animate ? 1 : 0);
      ctx.beginPath();
      ctx.arc(p.x, p.y, rr, 0, TAU);
      ctx.stroke();
      ctx.restore();
    }
    // Wireframe geometry: two counter-rotating hexagons.
    for (let h = 0; h < 2; h++) {
      const rot = fx.spin * (h === 0 ? 0.25 : -0.18) + h * 0.5;
      const rr = 26 * zoom;
      ctx.save();
      ctx.strokeStyle = h === 0 ? "rgba(249, 115, 22, 0.35)" : "rgba(34, 211, 238, 0.25)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let i = 0; i <= 6; i++) {
        const a = rot + (i / 6) * TAU;
        const x = p.x + Math.cos(a) * rr;
        const y = p.y + Math.sin(a) * rr;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
      ctx.restore();
    }
  }

  // Central energy core.
  const coreR = 21 * zoom * pulse;
  ctx.save();
  ctx.shadowColor = coreColor;
  ctx.shadowBlur = resolved.glow ? 16 + 20 * resolved.bloom : 0;
  const grad = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, coreR);
  grad.addColorStop(0, "rgba(255, 244, 230, 0.98)");
  grad.addColorStop(0.35, coreColor);
  grad.addColorStop(1, "rgba(8, 9, 10, 0.15)");
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.arc(p.x, p.y, coreR, 0, TAU);
  ctx.fill();
  ctx.restore();

  // Holographic label + real readouts.
  const sessions = graph.nodes.filter((n) => n.kind === "agent" && n.status !== "offline").length;
  const liveAgents = graph.nodes.filter((n) => n.kind === "agent" && (n.status === "live" || n.status === "busy")).length;
  const depts = graph.nodes.filter((n) => n.kind === "department").length;
  const failed = graph.nodes.filter((n) => n.status === "failed").length;
  const labelPx = Math.max(7, 9 * Math.min(1.15, zoom));
  ctx.save();
  ctx.textAlign = "center";
  ctx.font = `600 ${labelPx}px ui-monospace, monospace`;
  ctx.fillStyle = COLORS.textHi;
  ctx.fillText("YUPPY CORE", p.x, p.y + coreR + labelPx * 2.4);
  ctx.font = `${Math.max(6, labelPx * 0.8)}px ui-monospace, monospace`;
  ctx.fillStyle = failed > 0 ? COLORS.danger : COLORS.textLo;
  ctx.fillText(
    `pty ${liveAgents} · ajan ${sessions} · takım ${depts}${failed > 0 ? ` · hata ${failed}` : ""}`,
    p.x,
    p.y + coreR + labelPx * 3.7,
  );
  ctx.fillStyle = status === "connected" ? "rgba(34, 197, 94, 0.85)" : "rgba(239, 68, 68, 0.85)";
  ctx.fillText(
    status === "connected" ? "bridge çevrimiçi" : "bridge çevrimdışı",
    p.x,
    p.y + coreR + labelPx * 4.9,
  );
  ctx.restore();
}

/** Advance and draw one frame. Mutates `fx` (mutable visual state only). */
export function renderFrame(
  ctx: CanvasRenderingContext2D,
  view: Viewport,
  camera: Camera,
  graph: Graph,
  fx: Fx,
  resolved: ResolvedEffects,
  status: string,
  now: number,
  dtRaw: number,
  hovered: string | null,
): void {
  const dt = Math.min(0.06, Math.max(0, dtRaw));
  const staticMode = !resolved.enabled || resolved.reducedMotion;
  const animate = !staticMode;

  fx.time += dt;
  if (animate) {
    fx.spin += dt * resolved.speed;
    fx.radar += dt * 0.9 * resolved.speed;
  }
  fx.corePulse = Math.max(0, fx.corePulse - dt * 1.2);
  fx.coreError = Math.max(0, fx.coreError - dt * 1.5);

  // ── clear + environment
  ctx.setTransform(view.dpr, 0, 0, view.dpr, 0, 0);
  ctx.clearRect(0, 0, view.w, view.h);

  const bg = ctx.createRadialGradient(
    view.w / 2,
    view.h / 2,
    0,
    view.w / 2,
    view.h / 2,
    Math.max(view.w, view.h) * 0.62,
  );
  bg.addColorStop(0, "rgba(20, 21, 24, 0.55)");
  bg.addColorStop(1, "rgba(8, 9, 10, 0)");
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, view.w, view.h);

  if (resolved.enabled && resolved.ambient) drawGrid(ctx, view, camera);
  if (resolved.enabled && resolved.ambient && resolved.particles) {
    drawDust(ctx, view, camera, fx, resolved, dt, staticMode);
  }

  // ── sync node visual positions (smooth topology transitions + spawn)
  const alive = new Set<string>();
  for (const node of graph.nodes) {
    alive.add(node.id);
    let visual = fx.nodes.get(node.id);
    if (!visual) {
      visual = { x: node.tx, y: node.ty, born: 0 };
      fx.nodes.set(node.id, visual);
      if (animate) burst(fx, node.id, node.kind === "agent" ? COLORS.cyan : COLORS.accent, 8);
    }
    visual.x = ease(visual.x, node.tx, dt, 7);
    visual.y = ease(visual.y, node.ty, dt, 7);
    visual.born = Math.min(1, visual.born + dt * (animate ? 2.2 : 1));
  }
  for (const id of [...fx.nodes.keys()]) {
    if (alive.has(id)) continue;
    // Particle dissolve for a node that is no longer part of the real state.
    if (animate) burst(fx, id, "rgba(120, 113, 108, 0.8)", 8);
    fx.nodes.delete(id);
  }

  // ── edge lifecycle bookkeeping
  const edgeIds = new Set(graph.edges.map((e) => e.id));
  for (const edge of graph.edges) {
    if (!fx.edgeBorn.has(edge.id)) {
      fx.edgeBorn.set(edge.id, now);
      if (animate) {
        bumpCore(fx, 0.15);
        pulseNode(fx, edge.to, edgeColor(edge), 0.6);
      }
    }
  }
  for (const [id] of [...fx.edgeBorn]) {
    if (edgeIds.has(id)) continue;
    // The edge is already gone from the graph; reuse the last drawn geometry.
    const geom = fx.edgeGeom.get(id);
    if (geom) {
      fx.dying.set(id, {
        a: geom.a,
        b: geom.b,
        c: geom.c,
        born: now,
        color: geom.color,
      });
      fx.edgeGeom.delete(id);
    }
    fx.edgeBorn.delete(id);
  }

  if (!staticMode) {
    // Update flows: move along the *current* bezier path.
    for (const flow of fx.flows) {
      flow.age += dt;
      flow.t += flow.dir * flow.speed * dt;
      if (flow.loop) {
        if (flow.t > 1) flow.t = 0;
        if (flow.t < 0) flow.t = 1;
      }
    }
    fx.flows = fx.flows.filter((f) => {
      if (f.loop) return edgeIds.has(f.edgeId) && f.age < f.ttl;
      return edgeIds.has(f.edgeId) && f.t >= -0.05 && f.t <= 1.05 && f.age < f.ttl;
    });

    // Ambient flows on genuinely active edges only.
    if (resolved.particles) animatedEdgeSpawn(fx, graph, resolved, dt);

    // Sparks & sonar rings.
    for (const s of fx.sparks) {
      s.age += dt;
      s.x += s.vx * dt;
      s.y += s.vy * dt;
      s.vx *= 1 - Math.min(1, dt * 2.2);
      s.vy *= 1 - Math.min(1, dt * 2.2);
    }
    fx.sparks = fx.sparks.filter((s) => s.age < s.ttl);
    for (const r of fx.rings) r.age += dt;
    fx.rings = fx.rings.filter((r) => r.age < r.ttl);
    for (const p of fx.pulses) p.age += dt;
    fx.pulses = fx.pulses.filter((p) => p.age < p.ttl);
    for (const [id, v] of fx.activity) {
      const next = v - dt;
      if (next <= 0) fx.activity.delete(id);
      else fx.activity.set(id, next);
    }
  }

  // ── paint
  drawEdges(ctx, view, camera, graph, fx, now, staticMode);
  if (!staticMode) drawFlows(ctx, view, camera, graph, fx);

  // Event pulses (expanding node rings).
  for (const pulse of fx.pulses) {
    const node = fx.nodes.get(pulse.nodeId);
    if (!node) continue;
    const p = worldToScreen(camera, view, node);
    const t = pulse.age / pulse.ttl;
    const base = (pulse.nodeId === "core" ? 30 : 15) * camera.zoom;
    ctx.save();
    ctx.globalAlpha = (1 - t) * 0.7;
    ctx.strokeStyle = pulse.color;
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.arc(p.x, p.y, base + t * 26 * camera.zoom, 0, TAU);
    ctx.stroke();
    ctx.restore();
  }

  // Sonar rings from the core (new task / discovery).
  for (const ring of fx.rings) {
    const t = ring.age / ring.ttl;
    const p = worldToScreen(camera, view, { x: ring.x, y: ring.y });
    ctx.save();
    ctx.globalAlpha = (1 - t) * 0.5;
    ctx.strokeStyle = ring.color;
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.arc(p.x, p.y, 20 + t * ring.maxR * camera.zoom, 0, TAU);
    ctx.stroke();
    ctx.restore();
  }

  // Burst sparks.
  if (!staticMode) {
    for (const s of fx.sparks) {
      const p = worldToScreen(camera, view, { x: s.x, y: s.y });
      ctx.save();
      ctx.globalAlpha = Math.max(0, 1 - s.age / s.ttl);
      ctx.fillStyle = s.color;
      ctx.beginPath();
      ctx.arc(p.x, p.y, s.size, 0, TAU);
      ctx.fill();
      ctx.restore();
    }
  }

  drawNodes(ctx, view, camera, graph, fx, resolved, now, hovered);
  drawCore(ctx, view, camera, graph, fx, resolved, now, status);
}

/** Spawn a bounded number of ambient flows on active edges. */
function animatedEdgeSpawn(
  fx: Fx,
  graph: Graph,
  resolved: ResolvedEffects,
  dt: number,
): boolean {
  if (fx.flows.length >= resolved.particleCap) return false;
  for (const edge of graph.edges) {
    if (!edge.active) continue;
    const rate = edge.kind === "task" ? 2.2 : edge.kind === "conflict" ? 1.4 : 0.35;
    if (Math.random() > rate * dt) continue;
    if (fx.flows.length >= resolved.particleCap) break;
    const color =
      edge.kind === "conflict" ? COLORS.danger : edge.kind === "task" ? COLORS.ok : COLORS.cyan;
    fx.flows.push({
      edgeId: edge.id,
      t: edge.kind === "task" ? 0 : Math.random(),
      dir: edge.kind === "conflict" || Math.random() < 0.5 ? 1 : -1,
      speed: (edge.kind === "task" ? 0.55 : 0.3) * (0.8 + Math.random() * 0.5),
      size: edge.kind === "task" ? 1.7 : 1.1,
      color,
      loop: true,
      age: 0,
      ttl: 2.4 + Math.random() * 1.6,
    });
  }
  return true;
}

/** Emphasise one edge right now (task assignment / delegation emphasis). */
export function emphasizeEdge(fx: Fx, edgeId: string, color: string, count = 6): void {
  for (let i = 0; i < count; i++) {
    fx.flows.push({
      edgeId,
      t: Math.random() * 0.25,
      dir: 1,
      speed: 0.7 + Math.random() * 0.4,
      size: 2,
      color,
      loop: false,
      age: 0,
      ttl: 1.4 + Math.random() * 0.5,
    });
  }
  if (fx.flows.length > 320) fx.flows.splice(0, fx.flows.length - 320);
}
