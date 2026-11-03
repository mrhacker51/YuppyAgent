"use client";

import { create } from "zustand";

/**
 * Centralized, typed visual-effect configuration for the Web/Desktop HUD.
 *
 * Effects are presentation-only: they read the same zustand HUD store as
 * everything else and never influence agent execution, task management or
 * the bridge protocol. Preferences persist to localStorage under
 * `yuppy.effects.v1` (same pattern as the panel layout keys in `lib/store.ts`).
 */

export type QualityPreset = "low" | "balanced" | "high";
export type ReducedMotionPref = "auto" | "on" | "off";
/** Which network renderer to use. `auto` prefers WebGL 3D when available. */
export type RenderMode = "auto" | "3d" | "2d";

export interface EffectSettings {
  /** Master switch. When false the map renders as a static, fully usable graph. */
  enabled: boolean;
  quality: QualityPreset;
  /** Ambient particle field + holographic grid behind the map. */
  ambient: boolean;
  /** Progressive draw / flow animation on connections. */
  connections: boolean;
  /** Light particles traveling along connections. */
  particles: boolean;
  /** Pulsing / breathing glow on nodes. */
  nodeGlow: boolean;
  /** Central core animation (rings, pulse, radar). */
  core: boolean;
  /** HUD layer: radar sweep, sonar rings, scanlines, scanning beam. */
  hud: boolean;
  /** Particle density 0..1 (scales dust + flow particle caps). */
  density: number;
  /** Global animation speed multiplier 0.5..2. */
  speed: number;
  /** Glow/bloom intensity 0..1 (shadowBlur budget). */
  bloom: number;
  /** 3D WebGL universe, 2D React Flow map, or automatic WebGL detection. */
  renderMode: RenderMode;
  reducedMotion: ReducedMotionPref;
}

export const DEFAULT_SETTINGS: EffectSettings = {
  enabled: true,
  quality: "balanced",
  ambient: true,
  connections: true,
  particles: true,
  nodeGlow: true,
  core: true,
  hud: true,
  density: 0.6,
  speed: 1,
  bloom: 0.55,
  renderMode: "auto",
  reducedMotion: "auto",
};

/** Per-preset rendering budgets. Slider values override these individually. */
export const QUALITY_BUDGETS: Record<
  QualityPreset,
  { dprCap: number; dustCount: number; particleCap: number; glow: boolean; density: number; bloom: number }
> = {
  low: { dprCap: 1, dustCount: 24, particleCap: 48, glow: false, density: 0.35, bloom: 0.3 },
  balanced: { dprCap: 1.5, dustCount: 70, particleCap: 140, glow: true, density: 0.6, bloom: 0.55 },
  high: { dprCap: 2, dustCount: 130, particleCap: 260, glow: true, density: 0.85, bloom: 0.8 },
};

export const EFFECTS_STORAGE_KEY = "yuppy.effects.v1";

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Number.isFinite(value) ? value : min));
}

const QUALITIES: QualityPreset[] = ["low", "balanced", "high"];
const RENDER_MODES: RenderMode[] = ["auto", "3d", "2d"];

/** Coerce unknown (e.g. persisted) data into a valid EffectSettings. */
export function normalizeSettings(raw: unknown): EffectSettings {
  const v = (raw ?? {}) as Partial<EffectSettings>;
  const quality: QualityPreset = QUALITIES.includes(v.quality as QualityPreset)
    ? (v.quality as QualityPreset)
    : DEFAULT_SETTINGS.quality;
  const rm: ReducedMotionPref =
    v.reducedMotion === "on" || v.reducedMotion === "off" ? v.reducedMotion : "auto";
  const renderMode: RenderMode = RENDER_MODES.includes(v.renderMode as RenderMode)
    ? (v.renderMode as RenderMode)
    : DEFAULT_SETTINGS.renderMode;
  return {
    enabled: typeof v.enabled === "boolean" ? v.enabled : DEFAULT_SETTINGS.enabled,
    quality,
    ambient: typeof v.ambient === "boolean" ? v.ambient : DEFAULT_SETTINGS.ambient,
    connections: typeof v.connections === "boolean" ? v.connections : DEFAULT_SETTINGS.connections,
    particles: typeof v.particles === "boolean" ? v.particles : DEFAULT_SETTINGS.particles,
    nodeGlow: typeof v.nodeGlow === "boolean" ? v.nodeGlow : DEFAULT_SETTINGS.nodeGlow,
    core: typeof v.core === "boolean" ? v.core : DEFAULT_SETTINGS.core,
    hud: typeof v.hud === "boolean" ? v.hud : DEFAULT_SETTINGS.hud,
    density: clamp(v.density ?? DEFAULT_SETTINGS.density, 0, 1),
    speed: clamp(v.speed ?? DEFAULT_SETTINGS.speed, 0.5, 2),
    bloom: clamp(v.bloom ?? DEFAULT_SETTINGS.bloom, 0, 1),
    renderMode,
    reducedMotion: rm,
  };
}

/** Apply a quality preset over the current settings (budget fields only). */
export function applyPreset(
  settings: EffectSettings,
  preset: QualityPreset,
): Partial<EffectSettings> {
  const b = QUALITY_BUDGETS[preset];
  return { quality: preset, density: b.density, bloom: b.bloom };
}

export interface ResolvedEffects {
  enabled: boolean;
  reducedMotion: boolean;
  ambient: boolean;
  connections: boolean;
  particles: boolean;
  nodeGlow: boolean;
  core: boolean;
  hud: boolean;
  density: number;
  speed: number;
  bloom: number;
  dprCap: number;
  dustCount: number;
  /** Higher budget for the WebGL starfield (thousands of points are cheap). */
  sceneDust: number;
  particleCap: number;
  glow: boolean;
  renderMode: RenderMode;
}

/**
 * Merge user settings with the active quality budget and the OS-level
 * reduced-motion preference. Pure so it can be unit-tested in node.
 */
export function resolveEffects(
  settings: EffectSettings,
  prefersReducedMotion: boolean,
): ResolvedEffects {
  const budget = QUALITY_BUDGETS[settings.quality];
  const reducedMotion =
    settings.reducedMotion === "on" ||
    (settings.reducedMotion === "auto" && prefersReducedMotion);
  return {
    enabled: settings.enabled,
    reducedMotion,
    ambient: settings.ambient,
    connections: settings.connections,
    particles: settings.particles,
    nodeGlow: settings.nodeGlow,
    core: settings.core,
    hud: settings.hud,
    density: settings.density,
    speed: settings.speed,
    bloom: settings.bloom,
    dprCap: budget.dprCap,
    dustCount: Math.round(budget.dustCount * (0.4 + 0.6 * settings.density)),
    sceneDust: Math.round(budget.dustCount * 5 * (0.4 + 0.6 * settings.density)),
    particleCap: Math.round(budget.particleCap * (0.3 + 0.7 * settings.density)),
    glow: budget.glow && settings.bloom > 0.02,
    renderMode: settings.renderMode,
  };
}

export function loadSettings(): EffectSettings {
  if (typeof window === "undefined") return { ...DEFAULT_SETTINGS };
  try {
    const raw = window.localStorage.getItem(EFFECTS_STORAGE_KEY);
    const stored = raw ? (JSON.parse(raw) as Partial<EffectSettings>) : null;
    const settings = normalizeSettings(stored);
    // WebKitGTK heap-corrupts ("free(): corrupted unsorted chunks") when the
    // heavy WebGL universe renders inside the Tauri shell. Unless the user
    // explicitly chose a render mode, the desktop starts in 2D; the web keeps
    // the automatic WebGL preference.
    if (
      typeof window !== "undefined" &&
      "__TAURI_INTERNALS__" in window &&
      (!stored || stored.renderMode === undefined)
    ) {
      return { ...settings, renderMode: "2d" };
    }
    return settings;
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

function persist(settings: EffectSettings) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(EFFECTS_STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // Storage unavailable (private mode/quota) — effects still work in-memory.
  }
}

export function prefersReducedMotion(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

interface EffectsState {
  settings: EffectSettings;
  setSettings: (patch: Partial<EffectSettings>) => void;
  setQuality: (preset: QualityPreset) => void;
  reset: () => void;
}

export const useEffectsStore = create<EffectsState>((set, get) => ({
  settings: loadSettings(),
  setSettings: (patch) => {
    const next = normalizeSettings({ ...get().settings, ...patch });
    persist(next);
    set({ settings: next });
  },
  setQuality: (preset) => {
    const next = normalizeSettings({ ...get().settings, ...applyPreset(get().settings, preset) });
    persist(next);
    set({ settings: next });
  },
  reset: () => {
    persist({ ...DEFAULT_SETTINGS });
    set({ settings: { ...DEFAULT_SETTINGS } });
  },
}));
