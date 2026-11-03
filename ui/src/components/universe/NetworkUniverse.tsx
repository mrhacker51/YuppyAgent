"use client";

/*
 * React Three Fiber's documented API is imperative: shader uniforms, buffer
 * attributes and object transforms are mutated inside `useFrame` callbacks on
 * every animation frame. React's compiler lint cannot model that loop, so the
 * immutability rule is disabled for this WebGL scene only. All React state
 * still flows through hooks; nothing here mutates store or props.
 */
/* eslint-disable react-hooks/immutability */

import {
  Canvas,
  useFrame,
  useThree,
  type ThreeEvent,
} from "@react-three/fiber";
import { AdaptiveDpr, Grid, OrbitControls } from "@react-three/drei";
import {
  Bloom,
  ChromaticAberration,
  EffectComposer,
  Noise,
  ToneMapping,
  Vignette,
} from "@react-three/postprocessing";
import { BlendFunction, ToneMappingMode, type ChromaticAberrationEffect, type NoiseEffect } from "postprocessing";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { useHudStore } from "@/lib/store";
import { resolveEffects, useEffectsStore } from "@/lib/effects";
import { CITY, cityFromGraph, towerMetas, type TowerMeta } from "@/lib/city";
import { buildGraph, CORE_ID, hash01 } from "@/lib/networkGraph";
import { createDiffState, diffNetwork, type NetworkEvent } from "@/lib/networkEvents";
import {
  UNIVERSE,
  UNIVERSE_COLORS,
  createBodies,
  forceStep,
  graphStats,
  quadratic3,
  sampleCurve,
  syncBodies,
  taskEdgeId,
  taskStateFx,
  toneColor,
  type ForceBody,
  type UniverseEdge,
  type UniverseModel,
  type UniverseNode,
} from "@/lib/universe";

/* ── live effect state, mutated from store diffs and read in useFrame ──── */

let fxSeq = 0;

interface Burst {
  id: number;
  nodeId: string;
  at: number;
  color: string;
  strength: number;
}

interface RingFx {
  id: number;
  nodeId: string;
  at: number;
  color: string;
  max: number;
}

interface UniverseFx {
  corePulse: number;
  coreError: number;
  spin: number;
  radar: number;
  flash: number;
  activity: Map<string, number>;
  bursts: Burst[];
  rings: RingFx[];
  /** edge id -> arrival time (seconds) */
  edgePulse: Map<string, number>;
  glitchUntil: number;
}

function createFx(): UniverseFx {
  return {
    corePulse: 0,
    coreError: 0,
    spin: 0,
    radar: 0,
    flash: 0,
    activity: new Map(),
    bursts: [],
    rings: [],
    edgePulse: new Map(),
    glitchUntil: 0,
  };
}

function nowSec(): number {
  return performance.now() / 1000;
}

function pushBurst(fx: UniverseFx, nodeId: string, color: string, strength = 1): void {
  if (fx.bursts.length > 24) fx.bursts.shift();
  fxSeq += 1;
  fx.bursts.push({ id: fxSeq, nodeId, at: nowSec(), color, strength });
}

function pushRing(fx: UniverseFx, nodeId: string, color: string, max = 2.6): void {
  if (fx.rings.length > 10) fx.rings.shift();
  fxSeq += 1;
  fx.rings.push({ id: fxSeq, nodeId, at: nowSec(), color, max });
}

function pulseEdge(fx: UniverseFx, edgeId: string): void {
  fx.edgePulse.set(edgeId, nowSec());
}

function agentNodeId(cli: string): string {
  return `agent:${cli}`;
}

/* ── textures ─────────────────────────────────────────────────────────── */

function makeGlowTexture(color: string): THREE.CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 128;
  const ctx = canvas.getContext("2d");
  if (ctx) {
    const grad = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
    grad.addColorStop(0, color);
    grad.addColorStop(0.22, `${color}cc`);
    grad.addColorStop(0.55, `${color}33`);
    grad.addColorStop(1, `${color}00`);
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, 128, 128);
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

function makePointTexture(): THREE.CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 64;
  const ctx = canvas.getContext("2d");
  if (ctx) {
    const grad = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
    grad.addColorStop(0, "rgba(255,255,255,1)");
    grad.addColorStop(0.3, "rgba(255,255,255,0.7)");
    grad.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, 64, 64);
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

function makeLabelTexture(node: UniverseNode): { texture: THREE.CanvasTexture; aspect: number } {
  const width = 512;
  const height = 168;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (ctx) {
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = "rgba(6, 7, 10, 0.88)";
    ctx.strokeStyle = node.selected ? node.color : "rgba(120, 130, 140, 0.55)";
    ctx.lineWidth = 4;
    const r = 18;
    ctx.beginPath();
    ctx.roundRect(2, 2, width - 4, height - 4, r);
    ctx.fill();
    ctx.stroke();

    ctx.textAlign = "center";
    ctx.fillStyle = node.selected ? node.color : "#f5f5f4";
    ctx.font = "600 38px ui-monospace, SFMono-Regular, Menlo, monospace";
    const label = node.label.length > 26 ? `${node.label.slice(0, 25)}…` : node.label;
    ctx.fillText(label, width / 2, 70);

    ctx.fillStyle = "#d6d3d1";
    ctx.font = "400 24px ui-monospace, SFMono-Regular, Menlo, monospace";
    const sub = node.sub.length > 34 ? `${node.sub.slice(0, 33)}…` : node.sub;
    ctx.fillText(sub, width / 2, 116);

    ctx.fillStyle = node.color;
    ctx.beginPath();
    ctx.arc(width / 2, 140, 5, 0, Math.PI * 2);
    ctx.fill();
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.minFilter = THREE.LinearFilter;
  return { texture, aspect: width / height };
}

/* ── office-city helpers ──────────────────────────────────────────────── */

/**
 * Roads are flat: the bezier control is the ground midpoint between the two
 * live endpoints, so travel lines ride the streets instead of arcing through
 * the sky. Deterministic for identical endpoint pairs.
 */
function roadControl(a: THREE.Vector3 | { x: number; y: number; z: number }, b: { x: number; y: number; z: number }) {
  return { x: (a.x + b.x) / 2, y: CITY.ground, z: (a.z + b.z) / 2 };
}

/**
 * Tower facade: a grid of lit and dark windows, deterministic per department
 * id so a tower's lights never flicker between renders or reloads.
 */
function makeWindowTexture(lit: string, seed: string): THREE.CanvasTexture {
  const width = 128;
  const height = 256;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (ctx) {
    ctx.fillStyle = "#0a0c11";
    ctx.fillRect(0, 0, width, height);
    const cols = 7;
    const rows = 16;
    const cw = width / cols;
    const rh = height / rows;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const h = hash01(`${seed}:${c}:${r}`);
        const x = c * cw + cw * 0.22;
        const y = r * rh + rh * 0.26;
        if (h > 0.42) {
          ctx.globalAlpha = 0.35 + h * 0.65;
          ctx.fillStyle = lit;
        } else {
          ctx.globalAlpha = 1;
          ctx.fillStyle = "#151922";
        }
        ctx.fillRect(x, y, cw * 0.56, rh * 0.46);
      }
    }
    ctx.globalAlpha = 1;
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.NearestFilter;
  return texture;
}

/* ── shaders ──────────────────────────────────────────────────────────── */

const CORE_VERTEX = /* glsl */ `
  varying vec3 vNormal;
  varying vec3 vView;
  varying vec3 vPos;
  varying vec2 vUv;

  void main() {
    vUv = uv;
    vPos = position;
    vNormal = normalize(normalMatrix * normal);
    vec4 view = modelViewMatrix * vec4(position, 1.0);
    vView = normalize(-view.xyz);
    gl_Position = projectionMatrix * view;
  }
`;

const CORE_FRAGMENT = /* glsl */ `
  uniform float uTime;
  uniform float uPulse;
  uniform float uError;
  uniform float uActivity;
  varying vec3 vNormal;
  varying vec3 vView;
  varying vec3 vPos;
  varying vec2 vUv;

  float hash(vec2 p) {
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
  }

  float noise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(
      mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x),
      mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.1)), f.x),
      f.y
    );
  }

  // fbm: turbulent plasma veins inside the shell.
  float fbm(vec2 p) {
    float value = 0.0;
    float amplitude = 0.5;
    for (int i = 0; i < 5; i++) {
      value += amplitude * noise(p);
      p = p * 2.03 + vec2(1.7, 3.1);
      amplitude *= 0.5;
    }
    return value;
  }

  void main() {
    vec3 amber = vec3(0.976, 0.451, 0.086);
    vec3 cyan = vec3(0.133, 0.827, 0.933);
    vec3 violet = vec3(0.655, 0.545, 0.980);
    vec3 red = vec3(0.937, 0.267, 0.267);

    float t = uTime * 0.35;
    float veins = fbm(vUv * 6.0 + vec2(t, -t * 0.6));
    float veins2 = fbm(vUv * 13.0 - vec2(t * 1.4, t * 0.3));
    float bands = 0.5 + 0.5 * sin(vPos.y * 11.0 - uTime * 2.4 + veins * 6.0);
    float grain = fbm(vUv * 24.0 + uTime * 0.7);

    vec3 base = mix(amber, cyan, clamp(veins * 0.9 + 0.08 * sin(uTime * 0.4), 0.0, 1.0));
    base = mix(base, violet, veins2 * 0.18);
    base = mix(base, red, uError);

    float fresnel = pow(1.0 - max(dot(normalize(vNormal), normalize(vView)), 0.0), 2.2);
    float pulse = 0.14 * sin(uTime * 3.0) + uPulse * 0.65 + uActivity * 0.3;

    // Hot plasma filaments riding the surface: thin, very bright, bloom bait.
    float filament = smoothstep(0.72, 0.98, veins * bands + veins2 * 0.35);
    vec3 color =
      base * (0.30 + bands * 0.34 + grain * 0.14) +
      base * fresnel * 2.2 +
      mix(cyan, amber, veins) * filament * (1.6 + uPulse * 1.4) +
      base * pulse;

    float alpha = 0.60 + fresnel * 0.4;
    gl_FragColor = vec4(color, alpha);
  }
`;

const BACKDROP_VERTEX = /* glsl */ `
  varying vec3 vWorld;
  void main() {
    vec4 world = modelMatrix * vec4(position, 1.0);
    vWorld = normalize(world.xyz);
    gl_Position = projectionMatrix * viewMatrix * world;
  }
`;

const BACKDROP_FRAGMENT = /* glsl */ `
  uniform float uTime;
  varying vec3 vWorld;

  float hash(vec2 p) {
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
  }

  void main() {
    float h = clamp(vWorld.y * 0.5 + 0.5, 0.0, 1.0);
    vec3 top = vec3(0.012, 0.014, 0.022);
    vec3 bottom = vec3(0.045, 0.026, 0.018);
    vec3 color = mix(bottom, top, h);

    // Slow nebula bands, deliberately very low contrast.
    float n = sin(vWorld.x * 4.0 + uTime * 0.08) * sin(vWorld.z * 5.0 - uTime * 0.05);
    color += vec3(0.055, 0.026, 0.012) * smoothstep(0.25, 1.0, n) * 0.55;

    // Horizon glow behind the core.
    float horizon = smoothstep(0.35, 0.0, abs(h - 0.42));
    color += vec3(0.16, 0.07, 0.02) * horizon * 0.22;

    gl_FragColor = vec4(color, 1.0);
  }
`;

/* ── scene clock: decay shared FX, advance uniforms ───────────────────── */

function SceneClock({
  fxRef,
  spinSpeed,
  reducedMotion,
}: {
  fxRef: React.RefObject<UniverseFx>;
  spinSpeed: number;
  reducedMotion: boolean;
}) {
  useFrame((_, delta) => {
    const fx = fxRef.current;
    if (!fx) return;
    const dt = Math.min(0.06, delta);
    if (!reducedMotion) {
      fx.spin += dt * spinSpeed;
      fx.radar += dt * 0.85 * spinSpeed;
    }
    fx.corePulse = Math.max(0, fx.corePulse - dt * 1.1);
    fx.coreError = Math.max(0, fx.coreError - dt * 1.3);
    fx.flash = Math.max(0, fx.flash - dt * 1.5);
    const cut = nowSec() - 3.5;
    if (fx.bursts.length > 0 && fx.bursts[0].at < cut) {
      fx.bursts = fx.bursts.filter((b) => b.at >= cut);
    }
    if (fx.rings.length > 0 && fx.rings[0].at < cut) {
      fx.rings = fx.rings.filter((r) => r.at >= cut);
    }
    if (fx.edgePulse.size > 0) {
      for (const [id, at] of fx.edgePulse) {
        if (at < cut) fx.edgePulse.delete(id);
      }
    }
    if (fx.activity.size > 0) {
      for (const [id, value] of fx.activity) {
        const next = value - dt;
        if (next <= 0) fx.activity.delete(id);
        else fx.activity.set(id, next);
      }
    }
  });
  return null;
}

/* ── backdrop + perspective grid ──────────────────────────────────────── */

function Backdrop({ show }: { show: boolean }) {
  const material = useRef<THREE.ShaderMaterial>(null);
  const uniforms = useMemo(() => ({ uTime: { value: 0 } }), []);
  useFrame((_, delta) => {
    uniforms.uTime.value += Math.min(0.06, delta);
  });
  if (!show) return null;
  return (
    <mesh scale={42} renderOrder={-10}>
      <sphereGeometry args={[1, 48, 32]} />
      <shaderMaterial
        ref={material}
        side={THREE.BackSide}
        depthWrite={false}
        uniforms={uniforms}
        vertexShader={BACKDROP_VERTEX}
        fragmentShader={BACKDROP_FRAGMENT}
      />
    </mesh>
  );
}

function PerspectiveGrid({ show }: { show: boolean }) {
  if (!show) return null;
  return (
    <Grid
      position={[0, CITY.ground - 0.02, 0]}
      args={[110, 110]}
      cellSize={CITY.block / 5}
      cellThickness={0.5}
      cellColor="#1b2530"
      sectionSize={CITY.block}
      sectionThickness={1}
      sectionColor="#3b4a5c"
      fadeDistance={72}
      fadeStrength={1.6}
      infiniteGrid
    />
  );
}

/* ── office city: ground, plaza, roads, towers ────────────────────────── */

/** Dark asphalt plain plus the circular plaza the Jarvis core stands on. */
function CityGround() {
  return (
    <group>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0, 0]}>
        <circleGeometry args={[70, 72]} />
        <meshStandardMaterial color="#07080b" roughness={0.92} metalness={0.1} />
      </mesh>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, CITY.ground - 0.012, 0]}>
        <ringGeometry args={[CITY.plaza - 0.16, CITY.plaza, 64]} />
        <meshBasicMaterial
          color={UNIVERSE_COLORS.accent}
          transparent
          opacity={0.4}
          blending={THREE.AdditiveBlending}
          depthWrite={false}
          toneMapped={false}
        />
      </mesh>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, CITY.ground - 0.02, 0]}>
        <circleGeometry args={[CITY.plaza, 64]} />
        <meshStandardMaterial color="#0b0e13" roughness={0.8} metalness={0.3} />
      </mesh>
    </group>
  );
}

/**
 * Flat asphalt ribbons under every real edge. Endpoints follow the live
 * force-simulated bodies exactly like the glowing travel lines, so a road is
 * always physically under the data flow it represents.
 */
interface RoadHandle {
  edge: UniverseEdge;
  mesh: THREE.Mesh;
  geometry: THREE.BufferGeometry;
  positions: Float32Array;
  width: number;
  count: number;
}

function CityRoads({
  model,
  bodiesRef,
}: {
  model: UniverseModel;
  bodiesRef: React.RefObject<ForceBody[] | null>;
}) {
  const group = useRef<THREE.Group>(null);
  const material = useMemo(
    () =>
      new THREE.MeshStandardMaterial({
        color: "#101319",
        roughness: 0.95,
        metalness: 0.05,
        transparent: true,
        opacity: 0.96,
        polygonOffset: true,
        polygonOffsetFactor: -1,
      }),
    [],
  );

  const handles = useMemo<RoadHandle[]>(() => {
    const count = 24;
    return model.edges.map((edge) => {
      const geometry = new THREE.BufferGeometry();
      const positions = new Float32Array((count + 1) * 2 * 3);
      geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
      const index: number[] = [];
      for (let i = 0; i < count; i++) {
        const a = i * 2;
        index.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
      }
      geometry.setIndex(index);
      const mesh = new THREE.Mesh(
        geometry,
        edge.kind === "conflict"
          ? new THREE.MeshStandardMaterial({
              color: "#2a0f12",
              roughness: 0.95,
              transparent: true,
              opacity: 0.96,
              polygonOffset: true,
              polygonOffsetFactor: -1,
            })
          : material,
      );
      mesh.frustumCulled = false;
      return {
        edge,
        mesh,
        geometry,
        positions,
        width: edge.kind === "seat" ? 0.34 : 0.52,
        count,
      };
    });
  }, [model, material]);

  useEffect(() => {
    const root = group.current;
    if (!root) return;
    for (const handle of handles) root.add(handle.mesh);
    return () => {
      for (const handle of handles) {
        root.remove(handle.mesh);
        handle.geometry.dispose();
        if (handle.mesh.material !== material)
          (handle.mesh.material as THREE.Material).dispose();
      }
    };
  }, [handles, material]);

  useFrame(() => {
    const bodies = bodiesRef.current;
    if (!bodies) return;
    const byId = new Map(bodies.map((b) => [b.id, b]));
    for (const handle of handles) {
      const from = byId.get(handle.edge.from);
      const to = byId.get(handle.edge.to);
      if (!from || !to) continue;
      const a = { x: from.x, y: CITY.ground, z: from.z };
      const b = { x: to.x, y: CITY.ground, z: to.z };
      const c = roadControl(a, b);
      const half = handle.width / 2;
      for (let i = 0; i <= handle.count; i++) {
        const t = i / handle.count;
        const p = quadratic3(a, c, b, t);
        const q = quadratic3(a, c, b, Math.min(1, t + 0.001));
        const dx = q.x - p.x;
        const dz = q.z - p.z;
        const len = Math.hypot(dx, dz) || 1;
        const nx = (-dz / len) * half;
        const nz = (dx / len) * half;
        handle.positions[i * 6] = p.x + nx;
        handle.positions[i * 6 + 1] = CITY.ground;
        handle.positions[i * 6 + 2] = p.z + nz;
        handle.positions[i * 6 + 3] = p.x - nx;
        handle.positions[i * 6 + 4] = CITY.ground;
        handle.positions[i * 6 + 5] = p.z - nz;
      }
      (handle.geometry.getAttribute("position") as THREE.BufferAttribute).needsUpdate = true;
    }
  });

  return <group ref={group} />;
}

/**
 * A department rendered as an office tower: window strips, roof cap, edge
 * trim in the department's status colour, a live beacon while a PTY runs on
 * it, and a floating "TOWER · <department>" label. Selection, hover and drag
 * behave exactly like the graph nodes so the map stays interactive.
 */
function CityTower({
  node,
  meta,
  bodiesRef,
  resolved,
  fxRef,
  onSelect,
  dragRef,
  onHover,
}: {
  node: UniverseNode;
  meta: TowerMeta;
  bodiesRef: React.RefObject<ForceBody[] | null>;
  resolved: ReturnType<typeof resolveEffects>;
  fxRef: React.RefObject<UniverseFx>;
  onSelect: (node: UniverseNode) => void;
  dragRef: React.RefObject<{ id: string; y: number; moved: boolean } | null>;
  onHover: (node: UniverseNode | null) => void;
}) {
  const group = useRef<THREE.Group>(null);
  const beacon = useRef<THREE.Mesh>(null);
  const windows = useMemo(() => makeWindowTexture("#ffffff", node.id), [node.id]);
  const edges = useMemo(
    () =>
      new THREE.EdgesGeometry(
        new THREE.BoxGeometry(CITY.towerWidth + 0.04, meta.height + 0.04, CITY.towerDepth + 0.04),
      ),
    [meta.height],
  );
  const labelNode = useMemo(
    () => ({ ...node, label: `TOWER · ${node.label}` }),
    [node],
  );
  const { texture, aspect } = useMemo(() => makeLabelTexture(labelNode), [labelNode]);
  useEffect(
    () => () => {
      windows.dispose();
      edges.dispose();
    },
    [windows, edges],
  );
  useEffect(() => () => texture.dispose(), [texture]);

  useFrame(() => {
    const body = bodiesRef.current?.find((b) => b.id === node.id);
    if (group.current) group.current.position.set(body?.x ?? node.position.x, CITY.ground, body?.z ?? node.position.z);
    const fx = fxRef.current;
    if (beacon.current) {
      const live = node.status === "live" || node.status === "busy";
      const blink = resolved.reducedMotion ? 1 : 0.5 + Math.sin((fx?.spin ?? 0) * (live ? 5 : 1.4)) * 0.5;
      const mat = beacon.current.material as THREE.MeshBasicMaterial;
      mat.opacity = (node.status === "failed" ? 0.9 : live ? 0.85 : 0.35) * (0.4 + blink * 0.6);
      beacon.current.scale.setScalar(live ? 1 + blink * 0.4 : 1);
    }
  });

  const handleDown = (event: ThreeEvent<PointerEvent>) => {
    event.stopPropagation();
    dragRef.current = { id: node.id, y: CITY.ground, moved: false };
  };
  const handleUp = (event: ThreeEvent<PointerEvent>) => {
    event.stopPropagation();
    const drag = dragRef.current;
    if (drag && drag.id === node.id && !drag.moved) onSelect(node);
    dragRef.current = null;
  };

  return (
    <group ref={group} position={[node.position.x, CITY.ground, node.position.z]}>
      <mesh
        position={[0, meta.height / 2, 0]}
        onPointerDown={handleDown}
        onPointerUp={handleUp}
        onPointerOver={(event) => {
          event.stopPropagation();
          onHover(node);
          document.body.style.cursor = "grab";
        }}
        onPointerOut={() => {
          onHover(null);
          document.body.style.cursor = "";
        }}
        onDoubleClick={(event) => {
          event.stopPropagation();
          const body = bodiesRef.current?.find((b) => b.id === node.id);
          if (body) body.pinned = null;
        }}
      >
        <boxGeometry args={[CITY.towerWidth, meta.height, CITY.towerDepth]} />
        <meshStandardMaterial
          color="#0b0e13"
          emissive={new THREE.Color(node.color)}
          emissiveMap={windows}
          emissiveIntensity={node.status === "offline" || node.status === "disabled" ? 0.12 : 0.85}
          roughness={0.55}
          metalness={0.5}
        />
      </mesh>

      <mesh position={[0, meta.height + 0.06, 0]}>
        <boxGeometry args={[CITY.towerWidth + 0.18, 0.12, CITY.towerDepth + 0.18]} />
        <meshStandardMaterial color="#161b24" roughness={0.5} metalness={0.7} />
      </mesh>

      <lineSegments geometry={edges} position={[0, meta.height / 2, 0]}>
        <lineBasicMaterial
          color={node.color}
          transparent
          opacity={node.selected ? 0.9 : 0.4}
          blending={THREE.AdditiveBlending}
          depthWrite={false}
          toneMapped={false}
        />
      </lineSegments>

      <mesh ref={beacon} position={[0, meta.height + 0.42, 0]}>
        <sphereGeometry args={[0.09, 12, 12]} />
        <meshBasicMaterial
          color={node.status === "failed" ? UNIVERSE_COLORS.danger : node.color}
          transparent
          opacity={0.6}
          blending={THREE.AdditiveBlending}
          depthWrite={false}
          toneMapped={false}
        />
      </mesh>

      {node.selected && (
        <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, CITY.ground + 0.02, 0]}>
          <ringGeometry args={[CITY.podRadius + 0.5, CITY.podRadius + 0.66, 48]} />
          <meshBasicMaterial
            color={UNIVERSE_COLORS.accent}
            transparent
            opacity={0.5}
            blending={THREE.AdditiveBlending}
            depthWrite={false}
            toneMapped={false}
          />
        </mesh>
      )}

      <sprite position={[0, meta.height + 1.5, 0]} scale={[1.15 * aspect, 1.15, 1]}>
        <spriteMaterial
          map={texture}
          transparent
          depthWrite={false}
          depthTest={false}
          toneMapped={false}
          opacity={0.96}
        />
      </sprite>
    </group>
  );
}

/* ── Jarvis core ──────────────────────────────────────────────────────── */

function Core({
  fxRef,
  resolved,
  stats,
}: {
  fxRef: React.RefObject<UniverseFx>;
  resolved: ReturnType<typeof resolveEffects>;
  stats: ReturnType<typeof graphStats>;
}) {
  const group = useRef<THREE.Group>(null);
  const inner = useRef<THREE.Mesh>(null);
  const halo = useRef<THREE.Sprite>(null);
  const ringA = useRef<THREE.Mesh>(null);
  const ringB = useRef<THREE.Mesh>(null);
  const ringC = useRef<THREE.Mesh>(null);
  const radar = useRef<THREE.Group>(null);
  const orbiters = useRef<THREE.Group>(null);
  const uniforms = useMemo(
    () => ({
      uTime: { value: 0 },
      uPulse: { value: 0 },
      uError: { value: 0 },
      uActivity: { value: 0 },
    }),
    [],
  );
  const glow = useMemo(() => makeGlowTexture(UNIVERSE_COLORS.accent), []);
  useEffect(() => () => glow.dispose(), [glow]);

  useFrame((_, delta) => {
    const fx = fxRef.current;
    if (!fx) return;
    const dt = Math.min(0.06, delta);
    uniforms.uTime.value += dt;
    uniforms.uPulse.value = fx.corePulse;
    uniforms.uError.value = Math.min(1, fx.coreError);
    uniforms.uActivity.value = stats.live + stats.busy > 0 ? 1 : 0.25;

    const pulse = 1 + (resolved.reducedMotion ? 0 : Math.sin(fx.spin * 1.6) * 0.035) + fx.corePulse * 0.12;
    if (group.current) group.current.scale.setScalar(pulse);
    if (inner.current) inner.current.rotation.y = fx.spin * 0.35;
    if (ringA.current) ringA.current.rotation.z = fx.spin * 0.42;
    if (ringB.current) ringB.current.rotation.z = -fx.spin * 0.3;
    if (ringC.current) {
      ringC.current.rotation.x = Math.PI / 2 + Math.sin(fx.spin * 0.22) * 0.35;
      ringC.current.rotation.y = fx.spin * 0.18;
    }
    if (radar.current) radar.current.rotation.y = -fx.radar;
    if (orbiters.current) orbiters.current.rotation.y = fx.spin * 0.22;
    if (halo.current) {
      const s = 4.2 + Math.min(1, fx.corePulse) * 1.4;
      halo.current.scale.set(s, s, 1);
      const mat = halo.current.material as THREE.SpriteMaterial;
      mat.opacity = 0.48 + Math.min(1, fx.corePulse) * 0.35;
      mat.color.set(fx.coreError > 0.05 ? UNIVERSE_COLORS.danger : UNIVERSE_COLORS.accent);
    }
  });

  return (
    <group position={[0, UNIVERSE.coreY, 0]}>
      <sprite ref={halo} scale={[4.2, 4.2, 1]}>
        <spriteMaterial
          map={glow}
          transparent
          depthWrite={false}
          blending={THREE.AdditiveBlending}
          toneMapped={false}
          opacity={0.48}
        />
      </sprite>

      <group ref={group}>
        <mesh ref={inner}>
          <icosahedronGeometry args={[0.62, 6]} />
          <shaderMaterial
            uniforms={uniforms}
            vertexShader={CORE_VERTEX}
            fragmentShader={CORE_FRAGMENT}
            transparent
            depthWrite={false}
            blending={THREE.AdditiveBlending}
          />
        </mesh>

        <mesh scale={1.38}>
          <icosahedronGeometry args={[0.62, 2]} />
          <meshBasicMaterial
            color={UNIVERSE_COLORS.accent}
            wireframe
            transparent
            opacity={0.42}
            blending={THREE.AdditiveBlending}
            depthWrite={false}
          />
        </mesh>

        <mesh ref={ringA}>
          <torusGeometry args={[0.98, 0.008, 6, 128]} />
          <meshBasicMaterial
            color={UNIVERSE_COLORS.accent}
            transparent
            opacity={0.6}
            blending={THREE.AdditiveBlending}
            depthWrite={false}
          />
        </mesh>
        <mesh ref={ringB} rotation={[Math.PI / 2, 0, 0]}>
          <torusGeometry args={[1.18, 0.006, 6, 128]} />
          <meshBasicMaterial
            color={UNIVERSE_COLORS.cyan}
            transparent
            opacity={0.45}
            blending={THREE.AdditiveBlending}
            depthWrite={false}
          />
        </mesh>
        <mesh ref={ringC} rotation={[Math.PI / 2, 0, 0]}>
          <torusGeometry args={[1.45, 0.005, 6, 128]} />
          <meshBasicMaterial
            color={UNIVERSE_COLORS.violet}
            transparent
            opacity={0.3}
            blending={THREE.AdditiveBlending}
            depthWrite={false}
          />
        </mesh>

        {resolved.hud && !resolved.reducedMotion && (
          <group ref={radar} rotation={[-Math.PI / 2, 0, 0]}>
            <mesh>
              <ringGeometry args={[0.1, 2.7, 72, 1, 0, Math.PI * 0.62]} />
              <meshBasicMaterial
                color={UNIVERSE_COLORS.accent}
                transparent
                opacity={0.075}
                side={THREE.DoubleSide}
                blending={THREE.AdditiveBlending}
                depthWrite={false}
              />
            </mesh>
            <mesh position={[1.4, 0, 0]}>
              <boxGeometry args={[2.6, 0.008, 0.008]} />
              <meshBasicMaterial
                color={UNIVERSE_COLORS.accent}
                transparent
                opacity={0.35}
                blending={THREE.AdditiveBlending}
                depthWrite={false}
              />
            </mesh>
          </group>
        )}

        <group ref={orbiters}>
          {[0, 1, 2, 3].map((i) => {
            const angle = (i / 4) * Math.PI * 2;
            return (
              <mesh key={i} position={[Math.cos(angle) * 1.55, Math.sin(angle * 2) * 0.25, Math.sin(angle) * 1.55]}>
                <sphereGeometry args={[0.038, 12, 12]} />
                <meshBasicMaterial
                  color={i % 2 === 0 ? UNIVERSE_COLORS.cyan : UNIVERSE_COLORS.accent}
                  toneMapped={false}
                />
              </mesh>
            );
          })}
        </group>
      </group>
    </group>
  );
}

/* ── connections ──────────────────────────────────────────────────────── */

interface ConnectionHandle {
  edge: UniverseEdge;
  line: THREE.Line;
  geometry: THREE.BufferGeometry;
  material: THREE.LineBasicMaterial;
  positions: Float32Array;
  count: number;
  born: number;
  reveal: number;
}

function Connections({
  model,
  bodiesRef,
  resolved,
}: {
  model: UniverseModel;
  bodiesRef: React.RefObject<ForceBody[] | null>;
  resolved: ReturnType<typeof resolveEffects>;
}) {
  const group = useRef<THREE.Group>(null);
  const handles = useMemo(() => {
    return model.edges.map((edge) => {
      const points = sampleCurve(edge);
      const positions = new Float32Array(points.length * 3);
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
      const material = new THREE.LineBasicMaterial({
        color: new THREE.Color(edge.color),
        transparent: true,
        opacity: edge.active ? 0.82 : 0.3,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        toneMapped: false,
      });
      const line = new THREE.Line(geometry, material);
      geometry.setDrawRange(0, 0);
      return {
        edge,
        line,
        geometry,
        material,
        positions,
        count: points.length,
        born: nowSec(),
        reveal: resolved.connections && resolved.enabled ? 0 : 1,
      } satisfies ConnectionHandle;
    });
  }, [model, resolved.connections, resolved.enabled]);

  useEffect(() => {
    const root = group.current;
    if (!root) return;
    for (const handle of handles) root.add(handle.line);
    return () => {
      for (const handle of handles) {
        root.remove(handle.line);
        handle.geometry.dispose();
        handle.material.dispose();
      }
    };
  }, [handles]);

  useFrame((_, delta) => {
    const bodies = bodiesRef.current;
    if (!bodies) return;
    const byId = new Map(bodies.map((b) => [b.id, b]));
    const dt = Math.min(0.06, delta);
    for (const handle of handles) {
      const from = byId.get(handle.edge.from);
      const to = byId.get(handle.edge.to);
      if (!from || !to) continue;
      const a = { x: from.x, y: from.y, z: from.z };
      const b = { x: to.x, y: to.y, z: to.z };
      const c = roadControl(a, b);
      for (let i = 0; i < handle.count; i++) {
        const p = quadratic3(a, c, b, i / (handle.count - 1));
        handle.positions[i * 3] = p.x;
        handle.positions[i * 3 + 1] = p.y;
        handle.positions[i * 3 + 2] = p.z;
      }
      const attr = handle.geometry.getAttribute("position") as THREE.BufferAttribute;
      attr.needsUpdate = true;
      if (handle.reveal < 1) {
        handle.reveal = Math.min(1, handle.reveal + dt * 2.4);
      }
      handle.geometry.setDrawRange(0, Math.max(2, Math.round(handle.count * handle.reveal)));
      handle.material.opacity =
        (handle.edge.active ? 0.86 : 0.3) * (resolved.enabled ? 1 : 0.55);
    }
  });

  return <group ref={group} />;
}

/* ── traveling light particles (bidirectional data flow) ──────────────── */

interface FlowParticle {
  edgeId: string;
  t: number;
  dir: 1 | -1;
  speed: number;
  color: THREE.Color;
  size: number;
  life: number;
  maxLife: number;
}

function FlowParticles({
  model,
  bodiesRef,
  resolved,
  fxRef,
}: {
  model: UniverseModel;
  bodiesRef: React.RefObject<ForceBody[] | null>;
  resolved: ReturnType<typeof resolveEffects>;
  fxRef: React.RefObject<UniverseFx>;
}) {
  const points = useRef<THREE.Points>(null);
  const texture = useMemo(() => makePointTexture(), []);
  const edgeMap = useMemo(() => new Map(model.edges.map((e) => [e.id, e])), [model.edges]);
  const particles = useRef<FlowParticle[]>([]);
  const seenPulse = useRef(new Map<string, number>());
  const capacity = Math.max(24, Math.min(360, resolved.particleCap * 2));

  const geometry = useMemo(() => {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(capacity * 3), 3));
    g.setAttribute("color", new THREE.BufferAttribute(new Float32Array(capacity * 3), 3));
    g.setDrawRange(0, 0);
    return g;
  }, [capacity]);

  useEffect(() => () => geometry.dispose(), [geometry]);
  useEffect(() => () => texture.dispose(), [texture]);

  useFrame((_, delta) => {
    const bodies = bodiesRef.current;
    const fx = fxRef.current;
    if (!bodies || !fx) return;
    const dt = Math.min(0.06, delta);
    const byId = new Map(bodies.map((b) => [b.id, b]));
    const list = particles.current;

    if (!resolved.particles || !resolved.enabled) list.length = 0;

    // Event pulses: a new timestamp means "send energy along this edge".
    if (resolved.particles && resolved.enabled && !resolved.reducedMotion) {
      for (const [edgeId, at] of fx.edgePulse) {
        if (seenPulse.current.get(edgeId) === at) continue;
        seenPulse.current.set(edgeId, at);
        const edge = edgeMap.get(edgeId);
        if (!edge) continue;
        for (let i = 0; i < 8; i++) {
          if (list.length >= capacity) break;
          list.push({
            edgeId,
            t: (i / 8) * 0.9,
            dir: i % 2 === 0 ? 1 : -1,
            speed: 0.9 + Math.random() * 0.35,
            color: new THREE.Color(edge.color),
            size: 1.8,
            life: 1.5 + Math.random() * 0.7,
            maxLife: 2.2,
          });
        }
      }

      // Ambient flow only on edges that are genuinely active.
      for (const edge of model.edges) {
        if (!edge.active) continue;
        const rate = edge.kind === "task" ? 2.4 : edge.kind === "conflict" ? 1.6 : 0.7;
        if (Math.random() > rate * dt) continue;
        if (list.length >= capacity) break;
        const index = list.length;
        list.push({
          edgeId: edge.id,
          t: Math.random(),
          dir: edge.kind === "task" ? (index % 4 === 3 ? -1 : 1) : index % 2 === 0 ? 1 : -1,
          speed: (edge.kind === "task" ? 0.55 : 0.32) * (0.75 + Math.random() * 0.5),
          color: new THREE.Color(edge.color),
          size: edge.kind === "task" ? 1.5 : 1.1,
          life: 3 + Math.random() * 2,
          maxLife: 5,
        });
      }
    }

    // Advance along the *current* curve.
    for (const particle of list) {
      particle.t += particle.dir * particle.speed * dt;
      particle.life -= dt;
      if (particle.t > 1.02) particle.t = -0.02;
      if (particle.t < -0.02) particle.t = 1.02;
    }
    for (let i = list.length - 1; i >= 0; i--) {
      if (list[i].life <= 0) list.splice(i, 1);
    }
    if (list.length > capacity) list.splice(0, list.length - capacity);

    const pos = geometry.getAttribute("position") as THREE.BufferAttribute;
    const col = geometry.getAttribute("color") as THREE.BufferAttribute;
    let n = 0;
    for (const particle of list) {
      const edge = edgeMap.get(particle.edgeId);
      if (!edge) continue;
      const from = byId.get(edge.from);
      const to = byId.get(edge.to);
      if (!from || !to) continue;
      const a = { x: from.x, y: from.y, z: from.z };
      const b = { x: to.x, y: to.y, z: to.z };
      const c = roadControl(a, b);
      const p = quadratic3(a, c, b, particle.t);
      const fade = Math.min(1, particle.life / 0.6);
      pos.setXYZ(n, p.x, p.y, p.z);
      col.setXYZ(n, particle.color.r * fade, particle.color.g * fade, particle.color.b * fade);
      n += 1;
      if (n >= capacity) break;
    }
    pos.needsUpdate = true;
    col.needsUpdate = true;
    geometry.setDrawRange(0, n);
    if (points.current) points.current.visible = n > 0;
  });

  return (
    <points ref={points} geometry={geometry} frustumCulled={false}>
      <pointsMaterial
        size={0.115}
        sizeAttenuation
        map={texture}
        vertexColors
        transparent
        opacity={0.95}
        depthWrite={false}
        blending={THREE.AdditiveBlending}
        toneMapped={false}
      />
    </points>
  );
}

/* ── particle bursts + shockwave rings ────────────────────────────────── */

interface Spark {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  life: number;
  maxLife: number;
  color: THREE.Color;
}

function Sparks({
  fxRef,
  bodiesRef,
}: {
  fxRef: React.RefObject<UniverseFx>;
  bodiesRef: React.RefObject<ForceBody[] | null>;
}) {
  const points = useRef<THREE.Points>(null);
  const texture = useMemo(() => makePointTexture(), []);
  const sparks = useRef<Spark[]>([]);
  const seen = useRef(new Set<number>());
  const capacity = 320;

  const geometry = useMemo(() => {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(capacity * 3), 3));
    g.setAttribute("color", new THREE.BufferAttribute(new Float32Array(capacity * 3), 3));
    g.setDrawRange(0, 0);
    return g;
  }, []);

  useEffect(() => {
    return () => {
      geometry.dispose();
      texture.dispose();
    };
  }, [geometry, texture]);

  useFrame((_, delta) => {
    const fx = fxRef.current;
    const bodies = bodiesRef.current;
    if (!fx || !bodies) return;
    const dt = Math.min(0.06, delta);
    const byId = new Map(bodies.map((b) => [b.id, b]));

    for (const burst of fx.bursts) {
      if (seen.current.has(burst.id)) continue;
      seen.current.add(burst.id);
      const body = byId.get(burst.nodeId);
      if (!body) continue;
      const n = Math.round(18 + 18 * burst.strength);
      const color = new THREE.Color(burst.color);
      for (let i = 0; i < n; i++) {
        if (sparks.current.length >= capacity) break;
        const theta = Math.random() * Math.PI * 2;
        const phi = Math.acos(2 * Math.random() - 1);
        const speed = 0.7 + Math.random() * 2.2;
        sparks.current.push({
          x: body.x,
          y: body.y,
          z: body.z,
          vx: Math.sin(phi) * Math.cos(theta) * speed,
          vy: Math.cos(phi) * speed * 0.8,
          vz: Math.sin(phi) * Math.sin(theta) * speed,
          life: 0.55 + Math.random() * 0.65,
          maxLife: 1.2,
          color,
        });
      }
    }
    if (seen.current.size > 200) seen.current.clear();

    for (let i = sparks.current.length - 1; i >= 0; i--) {
      const s = sparks.current[i];
      s.life -= dt;
      s.x += s.vx * dt;
      s.y += s.vy * dt;
      s.z += s.vz * dt;
      s.vx *= 1 - Math.min(1, dt * 2.2);
      s.vy *= 1 - Math.min(1, dt * 2.2);
      s.vz *= 1 - Math.min(1, dt * 2.2);
      if (s.life <= 0) sparks.current.splice(i, 1);
    }

    const pos = geometry.getAttribute("position") as THREE.BufferAttribute;
    const col = geometry.getAttribute("color") as THREE.BufferAttribute;
    let n = 0;
    for (const s of sparks.current) {
      if (n >= capacity) break;
      const fade = Math.max(0, Math.min(1, s.life / s.maxLife));
      pos.setXYZ(n, s.x, s.y, s.z);
      col.setXYZ(n, s.color.r * fade, s.color.g * fade, s.color.b * fade);
      n += 1;
    }
    pos.needsUpdate = true;
    col.needsUpdate = true;
    geometry.setDrawRange(0, n);
    if (points.current) points.current.visible = n > 0;
  });

  return (
    <points ref={points} geometry={geometry} frustumCulled={false}>
      <pointsMaterial
        size={0.09}
        sizeAttenuation
        map={texture}
        vertexColors
        transparent
        opacity={0.95}
        depthWrite={false}
        blending={THREE.AdditiveBlending}
        toneMapped={false}
      />
    </points>
  );
}

function Shockwaves({
  fxRef,
  bodiesRef,
}: {
  fxRef: React.RefObject<UniverseFx>;
  bodiesRef: React.RefObject<ForceBody[] | null>;
}) {
  const group = useRef<THREE.Group>(null);
  const ringRefs = useRef<Array<THREE.Mesh | null>>(
    Array.from({ length: 8 }, () => null),
  );
  const state = useRef<Array<{ fx: RingFx; mesh: THREE.Mesh } | null>>(
    Array.from({ length: 8 }, () => null),
  );
  const seen = useRef(new Set<number>());

  useFrame((_, delta) => {
    const fx = fxRef.current;
    const bodies = bodiesRef.current;
    const root = group.current;
    if (!fx || !bodies || !root) return;
    const dt = Math.min(0.06, delta);
    const byId = new Map(bodies.map((b) => [b.id, b]));

    for (const ring of fx.rings) {
      if (seen.current.has(ring.id)) continue;
      seen.current.add(ring.id);
      const free = ringRefs.current.findIndex((value) => value == null);
      if (free < 0) continue;
      const mesh = new THREE.Mesh(
        new THREE.RingGeometry(0.35, 0.42, 64),
        new THREE.MeshBasicMaterial({
          color: new THREE.Color(ring.color),
          transparent: true,
          opacity: 0.7,
          side: THREE.DoubleSide,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
          toneMapped: false,
        }),
      );
      mesh.rotation.x = -Math.PI / 2;
      root.add(mesh);
      ringRefs.current[free] = mesh;
      state.current[free] = { fx: ring, mesh };
    }
    if (seen.current.size > 100) seen.current.clear();

    for (let i = 0; i < ringRefs.current.length; i++) {
      const entry = state.current[i];
      const mesh = ringRefs.current[i];
      if (!entry || !mesh) continue;
      const age = nowSec() - entry.fx.at;
      const t = Math.min(1, age / 1.5);
      const body = byId.get(entry.fx.nodeId);
      if (body) mesh.position.set(body.x, body.y, body.z);
      const scale = 1 + t * entry.fx.max * 2.4;
      mesh.scale.setScalar(scale);
      mesh.rotation.x = -Math.PI / 2 + (entry.fx.nodeId === CORE_ID ? 0 : 0);
      const material = mesh.material as THREE.MeshBasicMaterial;
      material.opacity = (1 - t) * 0.65;
      if (t >= 1) {
        root.remove(mesh);
        mesh.geometry.dispose();
        material.dispose();
        ringRefs.current[i] = null;
        state.current[i] = null;
      }
      void dt;
    }
  });

  return <group ref={group} />;
}

/* ── ambient dust field ───────────────────────────────────────────────── */

function Dust({ count, reducedMotion }: { count: number; reducedMotion: boolean }) {
  const points = useRef<THREE.Points>(null);
  const texture = useMemo(() => makePointTexture(), []);
  const geometry = useMemo(() => {
    const g = new THREE.BufferGeometry();
    const positions = new Float32Array(count * 3);
    const colors = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      // Deterministic pseudo-random so React re-renders never reshuffle the
      // starfield (and the render stays pure).
      const r1 = hash01(`dust:${i}:r`);
      const r2 = hash01(`dust:${i}:a`);
      const r3 = hash01(`dust:${i}:y`);
      const r4 = hash01(`dust:${i}:c`);
      const r5 = hash01(`dust:${i}:f`);
      const radius = 4 + r1 * 14;
      const angle = r2 * Math.PI * 2;
      positions[i * 3] = Math.cos(angle) * radius;
      positions[i * 3 + 1] = -1.5 + r3 * 9;
      positions[i * 3 + 2] = Math.sin(angle) * radius;
      const cool = r4 > 0.82;
      const color = new THREE.Color(cool ? UNIVERSE_COLORS.cyan : UNIVERSE_COLORS.accent);
      const fade = 0.35 + r5 * 0.65;
      colors[i * 3] = color.r * fade;
      colors[i * 3 + 1] = color.g * fade;
      colors[i * 3 + 2] = color.b * fade;
    }
    g.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    g.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    return g;
  }, [count]);

  useEffect(() => () => geometry.dispose(), [geometry]);
  useEffect(() => () => texture.dispose(), [texture]);

  useFrame((state, delta) => {
    const object = points.current;
    if (!object || reducedMotion) return;
    object.rotation.y += Math.min(0.06, delta) * 0.012;
    object.position.y = Math.sin(state.clock.elapsedTime * 0.14) * 0.12;
  });

  return (
    <points ref={points} geometry={geometry} frustumCulled={false}>
      <pointsMaterial
        size={0.05}
        sizeAttenuation
        map={texture}
        vertexColors
        transparent
        opacity={0.72}
        depthWrite={false}
        blending={THREE.AdditiveBlending}
        toneMapped={false}
      />
    </points>
  );
}

/* ── agent/department nodes with drag + hover ─────────────────────────── */

function NodeLabel({ node }: { node: UniverseNode }) {
  const { texture, aspect } = useMemo(() => makeLabelTexture(node), [node]);
  useEffect(() => () => texture.dispose(), [texture]);
  const height = 0.4;
  return (
    <sprite position={[0, node.radius + 0.5, 0]} scale={[height * aspect, height, 1]}>
      <spriteMaterial
        map={texture}
        transparent
        depthWrite={false}
        depthTest={false}
        toneMapped={false}
        opacity={0.95}
      />
    </sprite>
  );
}

function NodeObject({
  node,
  bodiesRef,
  resolved,
  fxRef,
  onSelect,
  dragRef,
  onHover,
}: {
  node: UniverseNode;
  bodiesRef: React.RefObject<ForceBody[] | null>;
  resolved: ReturnType<typeof resolveEffects>;
  fxRef: React.RefObject<UniverseFx>;
  onSelect: (node: UniverseNode) => void;
  dragRef: React.RefObject<{ id: string; y: number; moved: boolean } | null>;
  onHover: (node: UniverseNode | null) => void;
}) {
  const group = useRef<THREE.Group>(null);
  const shell = useRef<THREE.Mesh>(null);
  const ring = useRef<THREE.Mesh>(null);
  const glow = useMemo(() => makeGlowTexture(node.color), [node.color]);
  useEffect(() => () => glow.dispose(), [glow]);

  useFrame((_, delta) => {
    const dt = Math.min(0.06, delta);
    // Resolve the live body every frame: topology changes rebuild the array,
    // so a captured body object would freeze at its old position.
    const body = bodiesRef.current?.find((b) => b.id === node.id);
    if (group.current) {
      if (body) group.current.position.set(body.x, body.y, body.z);
      const target = 1;
      const current = group.current.scale.x;
      const next = current + (target - current) * Math.min(1, dt * 8);
      group.current.scale.setScalar(next);
    }
    const fx = fxRef.current;
    const activity = fx?.activity.get(node.id) ?? 0;
    const busy = node.status === "busy" || node.status === "live";
    const pulse =
      resolved.nodeGlow && !resolved.reducedMotion
        ? 1 + Math.sin((fx?.spin ?? 0) * (busy ? 3.4 : 1.6) + node.label.length) * (busy ? 0.12 : 0.04)
        : 1;
    if (shell.current) shell.current.scale.setScalar(pulse + activity * 0.25);
    if (ring.current) {
      ring.current.rotation.z = (fx?.spin ?? 0) * (busy ? 0.9 : 0.2);
      ring.current.scale.setScalar(1 + activity * 0.35);
    }
    const mat = shell.current?.material as THREE.MeshStandardMaterial | undefined;
    if (mat) {
      mat.emissiveIntensity = (node.status === "failed" ? 2.4 : busy ? 1.8 : 0.9) + activity * 1.6;
    }
  });

  const handleDown = (event: ThreeEvent<PointerEvent>) => {
    event.stopPropagation();
    const body = bodiesRef.current?.find((b) => b.id === node.id);
    dragRef.current = { id: node.id, y: body?.y ?? node.position.y, moved: false };
  };

  const handleUp = (event: ThreeEvent<PointerEvent>) => {
    event.stopPropagation();
    const drag = dragRef.current;
    if (drag && drag.id === node.id && !drag.moved) onSelect(node);
    dragRef.current = null;
  };

  return (
    <group ref={group} position={[node.position.x, node.position.y, node.position.z]}>
      <sprite scale={[1.7, 1.7, 1]} position={[0, 0, 0]}>
        <spriteMaterial
          map={glow}
          transparent
          depthWrite={false}
          blending={THREE.AdditiveBlending}
          toneMapped={false}
          opacity={node.status === "offline" || node.status === "disabled" ? 0.16 : 0.42}
        />
      </sprite>

      <mesh
        ref={shell}
        onPointerDown={handleDown}
        onPointerUp={handleUp}
        onPointerOver={(event) => {
          event.stopPropagation();
          onHover(node);
          document.body.style.cursor = "grab";
        }}
        onPointerOut={() => {
          onHover(null);
          document.body.style.cursor = "";
        }}
        onDoubleClick={(event) => {
          event.stopPropagation();
          const body = bodiesRef.current?.find((b) => b.id === node.id);
          if (body) body.pinned = null;
        }}
      >
        {node.kind === "agent" ? (
          <cylinderGeometry args={[node.radius * 0.82, node.radius, 0.5, 8]} />
        ) : (
          <sphereGeometry args={[node.radius, 24, 24]} />
        )}
        <meshStandardMaterial
          color="#0b0d10"
          emissive={new THREE.Color(node.color)}
          emissiveIntensity={node.status === "busy" ? 1.8 : 1}
          roughness={0.35}
          metalness={0.55}
          toneMapped={false}
        />
      </mesh>

      <mesh ref={ring} rotation={[Math.PI / 2, 0, 0]}>
        <torusGeometry args={[node.radius * 1.55, 0.012, 6, 48]} />
        <meshBasicMaterial
          color={node.color}
          transparent
          opacity={node.selected ? 0.95 : 0.5}
          blending={THREE.AdditiveBlending}
          depthWrite={false}
          toneMapped={false}
        />
      </mesh>

      {node.selected && (
        <mesh rotation={[Math.PI / 2, 0, 0]}>
          <torusGeometry args={[node.radius * 2.2, 0.008, 6, 64]} />
          <meshBasicMaterial
            color={UNIVERSE_COLORS.accent}
            transparent
            opacity={0.55}
            blending={THREE.AdditiveBlending}
            depthWrite={false}
            toneMapped={false}
          />
        </mesh>
      )}

      <NodeLabel node={node} />
    </group>
  );
}

/*
 * Owns the force simulation. It lives inside the render loop (not React
 * render) so topology changes can inject new bodies without mutating refs
 * while rendering. Newly spawned nodes get a real burst/shockwave the moment
 * the simulation first sees them.
 */
function Simulation({
  model,
  bodiesRef,
  fxRef,
}: {
  model: UniverseModel;
  bodiesRef: React.RefObject<ForceBody[] | null>;
  fxRef: React.RefObject<UniverseFx>;
}) {
  const modelRef = useRef<UniverseModel | null>(null);

  useFrame((_, delta) => {
    if (!bodiesRef.current) {
      bodiesRef.current = createBodies(model, "core");
      modelRef.current = model;
      return;
    }
    if (modelRef.current !== model) {
      const result = syncBodies(bodiesRef.current, model);
      bodiesRef.current = result.bodies;
      modelRef.current = model;
      const fx = fxRef.current;
      if (fx) {
        for (const id of result.spawned) {
          const node = model.byId.get(id);
          if (node) {
            pushBurst(fx, id, node.color, 1);
            pushRing(fx, id, node.color, node.kind === "department" ? 2.4 : 1.6);
          }
        }
      }
    }
    forceStep(bodiesRef.current, Math.min(0.06, delta));
  });

  return null;
}

function Nodes({
  model,
  metas,
  bodiesRef,
  resolved,
  fxRef,
  dragRef,
  onSelect,
  onHover,
}: {
  model: UniverseModel;
  metas: Map<string, TowerMeta>;
  bodiesRef: React.RefObject<ForceBody[] | null>;
  resolved: ReturnType<typeof resolveEffects>;
  fxRef: React.RefObject<UniverseFx>;
  dragRef: React.RefObject<{ id: string; y: number; moved: boolean } | null>;
  onSelect: (node: UniverseNode) => void;
  onHover: (node: UniverseNode | null) => void;
}) {
  return (
    <group>
      {model.nodes
        .filter((node) => node.kind !== "core")
        .map((node) => {
          if (node.kind === "department") {
            return (
              <CityTower
                key={node.id}
                node={node}
                meta={
                  metas.get(node.id) ?? {
                    height: CITY.minTowerHeight,
                    floors: 1,
                    roles: 0,
                    agents: 0,
                    liveAgents: 0,
                  }
                }
                bodiesRef={bodiesRef}
                resolved={resolved}
                fxRef={fxRef}
                onSelect={onSelect}
                dragRef={dragRef}
                onHover={onHover}
              />
            );
          }
          return (
            <NodeObject
              key={node.id}
              node={node}
              bodiesRef={bodiesRef}
              resolved={resolved}
              fxRef={fxRef}
              onSelect={onSelect}
              dragRef={dragRef}
              onHover={onHover}
            />
          );
        })}
    </group>
  );
}

/* ── drag controller: raycast to a horizontal plane ───────────────────── */

function DragController({
  bodiesRef,
  dragRef,
  onEnd,
}: {
  bodiesRef: React.RefObject<ForceBody[] | null>;
  dragRef: React.RefObject<{ id: string; y: number; moved: boolean } | null>;
  onEnd: () => void;
}) {
  const { camera, raycaster, pointer, controls } = useThree();
  const plane = useMemo(() => new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), []);
  const hit = useMemo(() => new THREE.Vector3(), []);

  useFrame(() => {
    const drag = dragRef.current;
    const bodies = bodiesRef.current;
    if (!drag || !bodies) return;
    const body = bodies.find((b) => b.id === drag.id);
    if (!body) return;
    plane.constant = -drag.y;
    raycaster.setFromCamera(pointer, camera);
    if (!raycaster.ray.intersectPlane(plane, hit)) return;
    const next = { x: hit.x, y: drag.y, z: hit.z };
    if (Math.hypot(next.x - body.x, next.z - body.z) > 0.04) drag.moved = true;
    body.pinned = next;
    const orbit = controls as unknown as { enabled: boolean } | null;
    if (orbit) orbit.enabled = false;
  });

  useEffect(() => {
    const up = () => {
      const drag = dragRef.current;
      if (drag) {
        const body = bodiesRef.current?.find((b) => b.id === drag.id);
        if (body && !drag.moved) body.pinned = null;
      }
      dragRef.current = null;
      const orbit = controls as unknown as { enabled: boolean } | null;
      if (orbit) orbit.enabled = true;
      onEnd();
    };
    window.addEventListener("pointerup", up);
    return () => window.removeEventListener("pointerup", up);
  }, [bodiesRef, controls, dragRef, onEnd]);

  return null;
}

/* ── scene composition ────────────────────────────────────────────────── */

function Scene({
  model,
  graph,
  fxRef,
  resolved,
  dragRef,
  onSelect,
  onHover,
}: {
  model: UniverseModel;
  graph: ReturnType<typeof buildGraph>;
  fxRef: React.RefObject<UniverseFx>;
  resolved: ReturnType<typeof resolveEffects>;
  dragRef: React.RefObject<{ id: string; y: number; moved: boolean } | null>;
  onSelect: (node: UniverseNode) => void;
  onHover: (node: UniverseNode | null) => void;
}) {
  const bodiesRef = useRef<ForceBody[] | null>(null);
  const stats = useMemo(() => graphStats(graph), [graph]);
  const metas = useMemo(() => towerMetas(graph, model), [graph, model]);
  const chromaRef = useRef<ChromaticAberrationEffect | null>(null);
  const noiseRef = useRef<NoiseEffect | null>(null);

  // Failure glitch: drive the real post-processing effects from the live fx
  // state instead of faking visuals — the distortion is strongest exactly
  // while a failed task or conflict is heating up the core.
  useFrame(() => {
    const fx = fxRef.current;
    if (!fx) return;
    const glitch = Math.max(0, Math.min(1, (fx.glitchUntil - nowSec()) / 0.42));
    const boost = Math.max(glitch, Math.min(1, fx.coreError) * 0.65);
    if (chromaRef.current) {
      const base = resolved.reducedMotion ? 0 : 0.0009;
      const m = base + boost * 0.0065;
      chromaRef.current.offset.set(m, m * 1.4);
    }
    if (noiseRef.current) {
      noiseRef.current.blendMode.opacity.value =
        (resolved.reducedMotion ? 0.006 : 0.018) + boost * 0.14;
    }
  });

  return (
    <>
      <Simulation model={model} bodiesRef={bodiesRef} fxRef={fxRef} />
      <SceneClock fxRef={fxRef} spinSpeed={resolved.speed} reducedMotion={resolved.reducedMotion} />
      <Backdrop show={resolved.enabled && resolved.ambient} />
      <PerspectiveGrid show={resolved.enabled && resolved.ambient} />
      <CityGround />
      <ambientLight intensity={0.55} />
      <pointLight position={[0, 8, 0]} intensity={40} color={UNIVERSE_COLORS.accent} distance={26} />
      <pointLight position={[-12, 5, 12]} intensity={16} color={UNIVERSE_COLORS.cyan} distance={30} />
      <pointLight position={[12, 4, -12]} intensity={12} color={UNIVERSE_COLORS.violet} distance={30} />

      {resolved.core && <Core fxRef={fxRef} resolved={resolved} stats={stats} />}
      <CityRoads model={model} bodiesRef={bodiesRef} />
      <Connections model={model} bodiesRef={bodiesRef} resolved={resolved} />
      <FlowParticles model={model} bodiesRef={bodiesRef} resolved={resolved} fxRef={fxRef} />
      <Sparks fxRef={fxRef} bodiesRef={bodiesRef} />
      <Shockwaves fxRef={fxRef} bodiesRef={bodiesRef} />
      <Dust count={resolved.sceneDust} reducedMotion={resolved.reducedMotion} />
      <Nodes
        model={model}
        metas={metas}
        bodiesRef={bodiesRef}
        resolved={resolved}
        fxRef={fxRef}
        dragRef={dragRef}
        onSelect={onSelect}
        onHover={onHover}
      />
      <DragController bodiesRef={bodiesRef} dragRef={dragRef} onEnd={() => undefined} />

      <OrbitControls
        makeDefault
        enablePan={false}
        enableZoom
        target={[0, 1.4, 0]}
        minDistance={9}
        maxDistance={64}
        minPolarAngle={0.35}
        maxPolarAngle={1.42}
        enableDamping
        dampingFactor={0.07}
        autoRotate={resolved.enabled && !resolved.reducedMotion}
        autoRotateSpeed={0.22}
      />

      <AdaptiveDpr pixelated={false} />

      <EffectComposer
        enabled={resolved.enabled}
        multisampling={0}
        enableNormalPass={false}
      >
        <Bloom
          intensity={resolved.glow ? 1.15 + resolved.bloom * 1.35 : 0.25}
          luminanceThreshold={0.2}
          luminanceSmoothing={0.32}
          mipmapBlur
        />
        <ChromaticAberration
          ref={chromaRef}
          offset={[0.0009, 0.0013]}
          radialModulation={false}
          modulationOffset={0}
        />
        <Noise ref={noiseRef} opacity={0.018} blendFunction={BlendFunction.OVERLAY} />
        <ToneMapping mode={ToneMappingMode.ACES_FILMIC} />
        <Vignette eskil={false} offset={0.18} darkness={0.78} />
      </EffectComposer>
    </>
  );
}

/* ── public component ─────────────────────────────────────────────────── */

export default function NetworkUniverse() {
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
  const [hover, setHover] = useState<UniverseNode | null>(null);
  const [flashNonce, setFlashNonce] = useState(0);
  const [glitching, setGlitching] = useState(false);
  const glitchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

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
  const model = useMemo(() => cityFromGraph(graph), [graph]);
  const resolved = useMemo(() => resolveEffects(settings, osReduced), [settings, osReduced]);
  const stats = useMemo(() => graphStats(graph), [graph]);
  const fxRef = useRef<UniverseFx>(createFx());
  const diffRef = useRef(createDiffState());
  const dragRef = useRef<{ id: string; y: number; moved: boolean } | null>(null);

  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setOsReduced(mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, []);

  const glitchNow = useCallback(() => {
    const fx = fxRef.current;
    fx.glitchUntil = nowSec() + 0.42;
    setGlitching(true);
    if (glitchTimer.current) clearTimeout(glitchTimer.current);
    glitchTimer.current = setTimeout(() => setGlitching(false), 430);
  }, []);

  useEffect(() => {
    return () => {
      if (glitchTimer.current) clearTimeout(glitchTimer.current);
    };
  }, []);

  const applyEvent = useCallback(
    (event: NetworkEvent) => {
      const fx = fxRef.current;
      switch (event.type) {
        case "session_open": {
          const nodeId = agentNodeId(event.agent);
          pushBurst(fx, nodeId, UNIVERSE_COLORS.ok, 1.1);
          pushRing(fx, nodeId, UNIVERSE_COLORS.ok, 1.8);
          pulseEdge(fx, taskEdgeId(event.agent));
          fx.corePulse = Math.min(1.6, fx.corePulse + 0.5);
          break;
        }
        case "session_close":
          pushRing(fx, agentNodeId(event.agent), UNIVERSE_COLORS.idle, 1.4);
          break;
        case "activity":
          fx.activity.set(agentNodeId(event.agent), 0.9);
          break;
        case "task": {
          const plan = taskStateFx(event.state);
          const nodeId = agentNodeId(event.cli);
          fx.corePulse = Math.min(1.8, fx.corePulse + plan.corePulse);
          if (plan.nodePulse > 0) pushRing(fx, nodeId, toneColor(plan.tone), 1.4 + plan.ring);
          if (plan.burst > 0) pushBurst(fx, nodeId, toneColor(plan.tone), plan.burst);
          if (plan.edgePulse > 0) pulseEdge(fx, taskEdgeId(event.cli));
          if (plan.flash) {
            fx.flash = 1;
            setFlashNonce((n) => n + 1);
          }
          if (plan.glitch) {
            fx.coreError = Math.min(1, fx.coreError + 0.9);
            glitchNow();
          }
          break;
        }
        case "conflict": {
          const a = tasks[event.taskA]?.cli;
          const b = tasks[event.taskB]?.cli;
          if (a) pushRing(fx, agentNodeId(a), UNIVERSE_COLORS.danger, 1.8);
          if (b) pushRing(fx, agentNodeId(b), UNIVERSE_COLORS.danger, 1.8);
          fx.coreError = Math.min(1, fx.coreError + 0.8);
          glitchNow();
          break;
        }
        case "error":
          fx.coreError = Math.min(1, fx.coreError + 0.7);
          glitchNow();
          break;
        case "status":
          if (event.status === "connected") {
            fx.corePulse = 1;
            pushRing(fx, CORE_ID, UNIVERSE_COLORS.ok, 3.2);
          } else if (event.status === "disconnected") {
            fx.coreError = 1;
            pushRing(fx, CORE_ID, UNIVERSE_COLORS.danger, 2.6);
          }
          break;
      }
    },
    [glitchNow, tasks],
  );

  useEffect(() => {
    const result = diffNetwork(diffRef.current, {
      sessions,
      tasks,
      conflicts,
      logs,
      status,
    });
    diffRef.current = result.next;
    for (const event of result.events) applyEvent(event);
  }, [sessions, tasks, conflicts, logs, status, applyEvent]);

  const onSelect = useCallback(
    (node: UniverseNode) => {
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
    },
    [],
  );

  const onHover = useCallback((node: UniverseNode | null) => setHover(node), []);

  return (
    <div
      className={`relative h-full w-full min-h-[260px] overflow-hidden border border-line bg-[#06070a] ${
        glitching ? "fx-glitch" : ""
      }`}
      role="application"
      aria-label="3B ajan ofis şehri. Departmanlar tower olarak durur, yollar gerçek bağlantılardır. Sürükleyerek kamerayı döndür, tekerlekle yakınlaştır; bir binayı veya podu sürükleyerek sabitle, çift tıklayarak serbest bırak."
    >
      <Canvas
        camera={{ position: [0, 15, 25], fov: 44, near: 0.1, far: 200 }}
        dpr={[1, Math.min(2, resolved.dprCap)]}
        gl={{ antialias: true, alpha: false, powerPreference: "high-performance" }}
        onCreated={({ gl }) => {
          gl.toneMapping = THREE.ACESFilmicToneMapping;
          gl.toneMappingExposure = 1.08;
        }}
        className="!absolute inset-0"
      >
        <color attach="background" args={["#06070a"]} />
        <fog attach="fog" args={["#06070a", 30, 95]} />
        <Scene
          model={model}
          graph={graph}
          fxRef={fxRef}
          resolved={resolved}
          dragRef={dragRef}
          onSelect={onSelect}
          onHover={onHover}
        />
      </Canvas>

      {resolved.enabled && resolved.hud && !resolved.reducedMotion && (
        <>
          <div className="fx-scanlines pointer-events-none" aria-hidden />
          <div className="fx-beam pointer-events-none" aria-hidden />
        </>
      )}
      <div className="holo-corners pointer-events-none" aria-hidden />

      {flashNonce > 0 && (
        <div key={flashNonce} className="universe-flash pointer-events-none" aria-hidden />
      )}

      <div className="pointer-events-none absolute left-2 top-2 flex flex-col gap-0.5 font-mono text-[8px] uppercase tracking-[0.14em] text-text-lo">
        <span className="text-text-mid">
          3B şehir · {stats.departments} tower · {stats.agents} ajan
        </span>
        <span>
          pty {sessions.length} · canlı {stats.live + stats.busy} · görev{" "}
          {Object.values(tasks).filter((t) => t.state === "running" || t.state === "awaiting_approval").length}
        </span>
      </div>

      <div className="pointer-events-none absolute right-2 top-8 flex flex-col items-end gap-0.5 font-mono text-[8px] uppercase tracking-[0.14em] text-text-lo">
        <span className="text-accent">tower · cadde · bloom · shader</span>
        <span>{resolved.reducedMotion ? "azaltılmış hareket" : "çift yönlü veri akışı"}</span>
      </div>

      {departments.length === 0 && (
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-1 text-center">
          <p className="font-mono text-[9px] uppercase tracking-[0.18em] text-text-lo">
            {status === "connected" ? "departmanlar yükleniyor…" : "bridge bağlı değil"}
          </p>
          <p className="max-w-[70%] text-[10px] leading-relaxed text-text-lo/80">
            Evren yalnızca backend&apos;in bildirdiği gerçek takımları ve süreçleri gösterir.
          </p>
        </div>
      )}

      {hover && (
        <div className="pointer-events-none absolute bottom-7 left-2 max-w-[72%] truncate border border-line bg-bg-0/90 px-1.5 py-0.5 font-mono text-[8px] text-text-mid">
          {hover.label} · {hover.sub}
        </div>
      )}

      <div className="pointer-events-none absolute bottom-1.5 left-2 flex items-center gap-1.5 font-mono text-[8px] uppercase tracking-wider text-text-lo/70">
        <span
          className={`size-1 rounded-full ${status === "connected" ? "bg-ok status-pulse" : "bg-danger"}`}
          aria-hidden
        />
        {status === "connected" ? "canlı şehir" : "çevrimdışı"}
      </div>

      <div className="pointer-events-none absolute bottom-1.5 right-2 font-mono text-[8px] uppercase tracking-wider text-text-lo/80">
        sürükle döndür · tekerlek zoom · düğümü sürükle
      </div>
    </div>
  );
}

