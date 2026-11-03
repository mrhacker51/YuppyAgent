"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useHudStore } from "@/lib/store";
import {
  resolveEffects,
  useEffectsStore,
  type ResolvedEffects,
} from "@/lib/effects";
import { buildGraph, CORE_ID, type Graph, type GraphNode } from "@/lib/networkGraph";
import {
  bumpCore,
  burst,
  COLORS,
  createFx,
  emphasizeEdge,
  glitch as flashGlitch,
  hitTest,
  pulseNode,
  renderFrame,
  resetCamera,
  sonar,
  type Camera,
  type Fx,
  type Viewport,
} from "@/lib/networkRenderer";

/** Keep the map's CFG clean: one loop reads refs, React only re-renders on data. */
const ACTIVITY_MS = 0.9;

function edgeIdForTask(cli: string): string {
  return `${CORE_ID}->agent:${cli}:task`;
}

export default function NetworkMap() {
  const departments = useHudStore((s) => s.departments);
  const agents = useHudStore((s) => s.agents);
  const sessions = useHudStore((s) => s.sessions);
  const tasks = useHudStore((s) => s.tasks);
  const conflicts = useHudStore((s) => s.conflicts);
  const logs = useHudStore((s) => s.logs);
  const status = useHudStore((s) => s.status);
  const selectedDept = useHudStore((s) => s.selectedDept);
  const selectedAgent = useHudStore((s) => s.selectedAgent);

  const settings = useEffectsStore((s) => s.settings);
  const [osReduced, setOsReduced] = useState(false);
  const [glitching, setGlitching] = useState(false);
  const [hoverInfo, setHoverInfo] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1);

  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const fxRef = useRef<Fx>(createFx());
  const cameraRef = useRef<Camera>({ x: 0, y: 0, zoom: 1 });
  const viewRef = useRef<Viewport>({ w: 0, h: 0, dpr: 1 });
  const graphRef = useRef<Graph>({ nodes: [], edges: [] });
  const resolvedRef = useRef<ResolvedEffects | null>(null);
  const hoverRef = useRef<string | null>(null);
  const userMovedRef = useRef(false);
  const sessionGenRef = useRef(new Map<string, number | undefined>());
  const glitchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const graph = useMemo(
    () =>
      buildGraph({
        departments,
        agents,
        sessions,
        tasks,
        conflicts,
        selectedDept,
        selectedAgent,
      }),
    [departments, agents, sessions, tasks, conflicts, selectedDept, selectedAgent],
  );
  const resolved = useMemo(() => resolveEffects(settings, osReduced), [settings, osReduced]);

  // Keep the render loop's inputs current without re-subscribing it.
  useEffect(() => {
    graphRef.current = graph;
    resolvedRef.current = resolved;
  }, [graph, resolved]);

  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setOsReduced(mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, []);

  const glitchNow = () => {
    const fx = fxRef.current;
    flashGlitch(fx, performance.now());
    setGlitching(true);
    if (glitchTimerRef.current) clearTimeout(glitchTimerRef.current);
    glitchTimerRef.current = setTimeout(() => setGlitching(false), 430);
  };

  /* ── real-event driven FX (diffed against previous store snapshots) ──── */
  const prevRef = useRef({
    sessionIds: new Set<string>(),
    taskStates: new Map<string, string>(),
    conflicts: 0,
    logs: 0,
    status: "",
    booted: false,
  });

  useEffect(() => {
    const fx = fxRef.current;
    const prev = prevRef.current;

    // Sessions: real PTY lifetime.
    const nextSessionIds = new Set(sessions.map((s) => s.id));
    if (prev.booted) {
      for (const s of sessions) {
        if (!prev.sessionIds.has(s.id)) {
          burst(fx, `agent:${s.agent}`, COLORS.ok, 12);
          pulseNode(fx, `agent:${s.agent}`, COLORS.ok);
          sonar(fx, COLORS.ok, 150);
          bumpCore(fx, 0.55);
          emphasizeEdge(fx, edgeIdForTask(s.agent), COLORS.ok, 5);
        }
      }
      for (const id of prev.sessionIds) {
        if (nextSessionIds.has(id)) continue;
        const gone = sessions.find((s) => s.id === id);
        void gone;
      }
    }
    prev.sessionIds = nextSessionIds;

    // Tasks: scheduler state transitions.
    for (const task of Object.values(tasks)) {
      if (!task.cli) continue;
      const prior = prev.taskStates.get(task.id);
      if (prior === task.state) continue;
      const nodeId = `agent:${task.cli}`;
      const edgeId = edgeIdForTask(task.cli);
      switch (task.state) {
        case "queued":
          sonar(fx, COLORS.accent, 170);
          pulseNode(fx, nodeId, COLORS.accent, 0.8);
          break;
        case "running":
        case "awaiting_approval":
          bumpCore(fx, 0.7);
          pulseNode(fx, nodeId, COLORS.accent);
          emphasizeEdge(fx, edgeId, COLORS.ok, 7);
          sonar(fx, COLORS.accent, 200);
          break;
        case "completed":
          burst(fx, nodeId, COLORS.ok, 14);
          pulseNode(fx, nodeId, COLORS.ok, 1.1);
          emphasizeEdge(fx, edgeId, COLORS.ok, 4);
          bumpCore(fx, 0.45);
          break;
        case "failed":
          burst(fx, nodeId, COLORS.danger, 14);
          pulseNode(fx, nodeId, COLORS.danger, 1.2);
          fx.coreError = Math.min(1, fx.coreError + 0.9);
          break;
        default:
          break;
      }
    }
    prev.taskStates = new Map(Object.values(tasks).map((t) => [t.id, t.state]));

    // Conflicts: the backend reported two executors touching one path.
    if (conflicts.length > prev.conflicts) {
      for (const c of conflicts.slice(prev.conflicts)) {
        const a = tasks[c.taskA]?.cli;
        const b = tasks[c.taskB]?.cli;
        if (a) pulseNode(fx, `agent:${a}`, COLORS.danger, 1.2);
        if (b) pulseNode(fx, `agent:${b}`, COLORS.danger, 1.2);
      }
      fx.coreError = Math.min(1, fx.coreError + 0.7);
      glitchNow();
    }
    prev.conflicts = conflicts.length;

    // Errors: bridge log errors get the controlled glitch, not constant shake.
    if (logs.length > prev.logs) {
      const fresh = logs.slice(prev.logs);
      if (fresh.some((l) => l.level === "error")) {
        fx.coreError = Math.min(1, fx.coreError + 0.6);
        glitchNow();
      }
    }
    prev.logs = logs.length;

    // Bridge connect / disconnect: core response.
    if (prev.status && prev.status !== status) {
      if (status === "connected") {
        bumpCore(fx, 1);
        sonar(fx, COLORS.ok, 220);
        pulseNode(fx, CORE_ID, COLORS.ok, 1);
      } else if (status === "disconnected") {
        fx.coreError = 1;
        pulseNode(fx, CORE_ID, COLORS.danger, 1);
      }
    }
    prev.status = status;
    prev.booted = true;
  }, [sessions, tasks, conflicts, logs, status]);

  /* ── single animation loop + canvas sizing + pointer/keyboard input ──── */
  useEffect(() => {
    const container = containerRef.current;
    const canvas = canvasRef.current;
    if (!container || !canvas) return;

    const resize = () => {
      const rect = container.getBoundingClientRect();
      const view = viewRef.current;
      const first = view.w === 0 || view.h === 0;
      view.w = Math.max(1, rect.width);
      view.h = Math.max(1, rect.height);
      if (first && !userMovedRef.current) {
        cameraRef.current = resetCamera(view);
        setZoom(cameraRef.current.zoom);
      }
    };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(container);

    let raf = 0;
    let last = performance.now();
    const frame = (now: number) => {
      const dt = (now - last) / 1000;
      last = now;
      // Hidden windows (minimized Tauri shell / background tab) burn no CPU.
      if (typeof document !== "undefined" && document.hidden) {
        raf = requestAnimationFrame(frame);
        return;
      }
      const view = viewRef.current;
      const fx = fxRef.current;
      const graphNow = graphRef.current;
      const fxSettings = resolvedRef.current;
      const ctx = canvas.getContext("2d");
      if (!ctx || view.w === 0 || !fxSettings) {
        raf = requestAnimationFrame(frame);
        return;
      }
      const dpr = Math.min(fxSettings.dprCap, window.devicePixelRatio || 1);
      if (view.dpr !== dpr) {
        view.dpr = dpr;
        canvas.width = Math.max(1, Math.round(view.w * dpr));
        canvas.height = Math.max(1, Math.round(view.h * dpr));
      }

      // Terminal activity: a new PTY screen generation means the agent is
      // doing something right now (throttled to the coalesced store rate).
      for (const session of useHudStore.getState().sessions) {
        const prevGen = sessionGenRef.current.get(session.id);
        if (session.generation != null && prevGen != null && session.generation !== prevGen) {
          fx.activity.set(`agent:${session.agent}`, ACTIVITY_MS);
        }
        sessionGenRef.current.set(session.id, session.generation);
      }

      renderFrame(
        ctx,
        view,
        cameraRef.current,
        graphNow,
        fx,
        fxSettings,
        useHudStore.getState().status,
        now,
        dt,
        hoverRef.current,
      );
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);

    // ── pointer: hover, pan, click-select, wheel zoom
    let dragging = false;
    let dragged = false;
    let lastX = 0;
    let lastY = 0;

    const nodeAt = (event: PointerEvent | MouseEvent): GraphNode | null => {
      const rect = canvas.getBoundingClientRect();
      return hitTest(
        cameraRef.current,
        viewRef.current,
        fxRef.current,
        graphRef.current,
        event.clientX - rect.left,
        event.clientY - rect.top,
      );
    };

    const onPointerDown = (event: PointerEvent) => {
      if (event.button !== 0) return;
      dragging = true;
      dragged = false;
      lastX = event.clientX;
      lastY = event.clientY;
      canvas.setPointerCapture(event.pointerId);
    };
    const onPointerMove = (event: PointerEvent) => {
      if (dragging) {
        const dx = event.clientX - lastX;
        const dy = event.clientY - lastY;
        if (Math.abs(dx) + Math.abs(dy) > 2) dragged = true;
        cameraRef.current.x -= dx / cameraRef.current.zoom;
        cameraRef.current.y -= dy / cameraRef.current.zoom;
        userMovedRef.current = true;
        lastX = event.clientX;
        lastY = event.clientY;
        return;
      }
      const node = nodeAt(event);
      const id = node?.id ?? null;
      if (hoverRef.current !== id) {
        hoverRef.current = id;
        canvas.style.cursor = node ? "pointer" : "grab";
        setHoverInfo(
          node && node.kind !== "core" ? `${node.label} · ${node.sub}` : null,
        );
      }
    };
    const onPointerUp = (event: PointerEvent) => {
      if (!dragging) return;
      dragging = false;
      try {
        canvas.releasePointerCapture(event.pointerId);
      } catch {
        // pointer already released
      }
      if (dragged) return;
      const node = nodeAt(event);
      if (!node) return;
      const state = useHudStore.getState();
      if (node.kind === "department") {
        const id = node.id.slice("dept:".length);
        state.setSelectedDept(state.selectedDept === id ? "" : id);
      } else if (node.kind === "agent") {
        const id = node.id.slice("agent:".length);
        state.setSelectedAgent(id);
        const session = state.sessions.find((s) => s.agent === id);
        if (session) state.focusSession(session.id);
      }
    };
    const onPointerLeave = () => {
      hoverRef.current = null;
      setHoverInfo(null);
      canvas.style.cursor = "grab";
    };
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const sx = event.clientX - rect.left;
      const sy = event.clientY - rect.top;
      const view = viewRef.current;
      const cam = cameraRef.current;
      const worldX = (sx - view.w / 2) / cam.zoom + cam.x;
      const worldY = (sy - view.h / 2) / cam.zoom + cam.y;
      const next = Math.min(2.6, Math.max(0.45, cam.zoom * Math.exp(-event.deltaY * 0.0012)));
      cam.zoom = next;
      cam.x = worldX - (sx - view.w / 2) / next;
      cam.y = worldY - (sy - view.h / 2) / next;
      userMovedRef.current = true;
      setZoom(Number(next.toFixed(2)));
    };
    const onDoubleClick = () => {
      cameraRef.current = resetCamera(viewRef.current);
      userMovedRef.current = false;
      setZoom(Number(cameraRef.current.zoom.toFixed(2)));
    };

    canvas.style.cursor = "grab";
    canvas.addEventListener("pointerdown", onPointerDown);
    canvas.addEventListener("pointermove", onPointerMove);
    canvas.addEventListener("pointerup", onPointerUp);
    canvas.addEventListener("pointerleave", onPointerLeave);
    canvas.addEventListener("wheel", onWheel, { passive: false });
    canvas.addEventListener("dblclick", onDoubleClick);
    window.addEventListener("pointerup", onPointerUp);

    return () => {
      cancelAnimationFrame(raf);
      observer.disconnect();
      canvas.removeEventListener("pointerdown", onPointerDown);
      canvas.removeEventListener("pointermove", onPointerMove);
      canvas.removeEventListener("pointerup", onPointerUp);
      canvas.removeEventListener("pointerleave", onPointerLeave);
      canvas.removeEventListener("wheel", onWheel);
      canvas.removeEventListener("dblclick", onDoubleClick);
      window.removeEventListener("pointerup", onPointerUp);
    };
  }, []);

  /* ── keyboard navigation (the DOM aside remains the primary a11y path) ─ */
  const keyboardIndexRef = useRef(-1);
  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const nodes = graphRef.current.nodes;
    if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
      event.preventDefault();
      if (nodes.length === 0) return;
      const dir = event.key === "ArrowRight" ? 1 : -1;
      keyboardIndexRef.current =
        (keyboardIndexRef.current + dir + nodes.length) % nodes.length;
      const node = nodes[keyboardIndexRef.current];
      hoverRef.current = node.id;
      setHoverInfo(`${node.label} · ${node.sub}`);
      return;
    }
    if (event.key === "Enter" && hoverRef.current) {
      event.preventDefault();
      const state = useHudStore.getState();
      const id = hoverRef.current;
      if (id.startsWith("dept:")) {
        const dept = id.slice("dept:".length);
        state.setSelectedDept(state.selectedDept === dept ? "" : dept);
      } else if (id.startsWith("agent:")) {
        state.setSelectedAgent(id.slice("agent:".length));
      }
      return;
    }
    if (event.key === "+" || event.key === "=") {
      event.preventDefault();
      cameraRef.current.zoom = Math.min(2.6, cameraRef.current.zoom * 1.15);
      userMovedRef.current = true;
      setZoom(Number(cameraRef.current.zoom.toFixed(2)));
      return;
    }
    if (event.key === "-") {
      event.preventDefault();
      cameraRef.current.zoom = Math.max(0.45, cameraRef.current.zoom / 1.15);
      userMovedRef.current = true;
      setZoom(Number(cameraRef.current.zoom.toFixed(2)));
      return;
    }
    if (event.key === "0") {
      event.preventDefault();
      cameraRef.current = resetCamera(viewRef.current);
      userMovedRef.current = false;
      setZoom(Number(cameraRef.current.zoom.toFixed(2)));
      return;
    }
    if (event.key === "Escape") {
      hoverRef.current = null;
      setHoverInfo(null);
    }
  };

  useEffect(() => {
    return () => {
      if (glitchTimerRef.current) clearTimeout(glitchTimerRef.current);
    };
  }, []);

  const liveSessions = sessions.length;
  const runningTasks = Object.values(tasks).filter(
    (t) => t.state === "running" || t.state === "awaiting_approval",
  ).length;

  return (
    <div
      ref={containerRef}
      tabIndex={0}
      role="application"
      aria-label="Canlı ajan ağı haritası. Sürükleyerek kaydır, tekerlekle yakınlaştır; bir düğüme tıklayarak seç. Ok tuşları düğümler arasında gezinir, Enter seçer."
      onKeyDown={onKeyDown}
      className={`group relative h-full w-full min-h-[220px] overflow-hidden border border-line bg-[#08090a] outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-accent/50 ${
        glitching ? "fx-glitch" : ""
      }`}
    >
      <canvas ref={canvasRef} className="block h-full w-full" aria-hidden />

      {resolved.enabled && resolved.hud && !resolved.reducedMotion && (
        <>
          <div className="fx-scanlines pointer-events-none" aria-hidden />
          <div className="fx-beam pointer-events-none" aria-hidden />
        </>
      )}
      <div className="holo-corners pointer-events-none" aria-hidden />

      <div className="pointer-events-none absolute left-2 top-2 flex flex-col gap-0.5 font-mono text-[8px] uppercase tracking-[0.14em] text-text-lo">
        <span className="text-text-mid">
          ağ haritası · {departments.length} takım · {agents.length} ajan
        </span>
        <span>
          pty {liveSessions} · görev {runningTasks}
        </span>
      </div>

      {departments.length === 0 && (
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-1 text-center">
          <p className="font-mono text-[9px] uppercase tracking-[0.18em] text-text-lo">
            {status === "connected" ? "departmanlar yükleniyor…" : "bridge bağlı değil"}
          </p>
          <p className="max-w-[70%] text-[10px] leading-relaxed text-text-lo/80">
            Harita yalnızca backend&apos;in bildirdiği gerçek takımları ve süreçleri gösterir.
          </p>
        </div>
      )}

      {hoverInfo && (
        <div className="pointer-events-none absolute bottom-6 left-2 max-w-[70%] truncate border border-line bg-bg-0/90 px-1.5 py-0.5 font-mono text-[8px] text-text-mid">
          {hoverInfo}
        </div>
      )}

      <div className="pointer-events-none absolute bottom-1.5 right-2 font-mono text-[8px] uppercase tracking-wider text-text-lo/80">
        {Math.round(zoom * 100)}% · tekerlek zoom · sürükle kaydır · çift tık sıfırla
      </div>

      {resolved.enabled && (
        <div className="pointer-events-none absolute bottom-1.5 left-2 flex items-center gap-1.5 font-mono text-[8px] uppercase tracking-wider text-text-lo/70">
          <span
            className={`size-1 rounded-full ${
              status === "connected" ? "bg-ok status-pulse" : "bg-danger"
            }`}
            aria-hidden
          />
          {status === "connected" ? "canlı ağ" : "çevrimdışı"}
          {resolved.reducedMotion && <span className="text-text-lo/60">· azaltılmış hareket</span>}
        </div>
      )}
    </div>
  );
}
