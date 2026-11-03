/**
 * Effect-settings contract: presets, clamping, reduced-motion resolution and
 * the budget merge. The renderer reads `ResolvedEffects`; keeping this pure
 * means the quality presets are testable without a canvas or a browser.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_SETTINGS,
  QUALITY_BUDGETS,
  applyPreset,
  normalizeSettings,
  resolveEffects,
} from "@/lib/effects";

test("empty input normalizes to the documented defaults", () => {
  const s = normalizeSettings(null);
  assert.deepEqual(s, DEFAULT_SETTINGS);
});

test("unknown persisted values are rejected, numbers are clamped", () => {
  const s = normalizeSettings({
    enabled: "yes",
    quality: "ultra",
    reducedMotion: "sometimes",
    density: 4,
    speed: -3,
    bloom: 99,
  });
  assert.equal(s.enabled, DEFAULT_SETTINGS.enabled);
  assert.equal(s.quality, DEFAULT_SETTINGS.quality);
  assert.equal(s.reducedMotion, "auto");
  assert.equal(s.density, 1);
  assert.equal(s.speed, 0.5);
  assert.equal(s.bloom, 1);
});

test("quality presets set the rendering budget fields", () => {
  for (const preset of ["low", "balanced", "high"] as const) {
    const patch = applyPreset(DEFAULT_SETTINGS, preset);
    assert.equal(patch.quality, preset);
    assert.equal(patch.density, QUALITY_BUDGETS[preset].density);
    assert.equal(patch.bloom, QUALITY_BUDGETS[preset].bloom);
  }
});

test("resolveEffects merges the preset budget and scales counts by density", () => {
  const low = resolveEffects({ ...DEFAULT_SETTINGS, quality: "low", density: 0 }, false);
  const high = resolveEffects({ ...DEFAULT_SETTINGS, quality: "high", density: 1 }, false);
  assert.equal(low.dprCap, QUALITY_BUDGETS.low.dprCap);
  assert.equal(high.dprCap, QUALITY_BUDGETS.high.dprCap);
  assert.equal(low.glow, false);
  assert.equal(high.glow, true);
  assert.ok(high.dustCount > low.dustCount);
  assert.ok(high.particleCap > low.particleCap);
});

test("reduced-motion: explicit on wins, auto follows the OS, off overrides the OS", () => {
  assert.equal(
    resolveEffects({ ...DEFAULT_SETTINGS, reducedMotion: "on" }, false).reducedMotion,
    true,
  );
  assert.equal(
    resolveEffects({ ...DEFAULT_SETTINGS, reducedMotion: "auto" }, true).reducedMotion,
    true,
  );
  assert.equal(
    resolveEffects({ ...DEFAULT_SETTINGS, reducedMotion: "auto" }, false).reducedMotion,
    false,
  );
  assert.equal(
    resolveEffects({ ...DEFAULT_SETTINGS, reducedMotion: "off" }, true).reducedMotion,
    false,
  );
});

test("master switch and bloom are independent of each other", () => {
  const off = resolveEffects({ ...DEFAULT_SETTINGS, enabled: false }, false);
  assert.equal(off.enabled, false);
  const noBloom = resolveEffects({ ...DEFAULT_SETTINGS, bloom: 0 }, false);
  assert.equal(noBloom.glow, false);
});

test("render mode: auto by default, persisted values validated per field", () => {
  assert.equal(DEFAULT_SETTINGS.renderMode, "auto");
  assert.equal(normalizeSettings({ renderMode: "3d" }).renderMode, "3d");
  assert.equal(normalizeSettings({ renderMode: "2d" }).renderMode, "2d");
  assert.equal(normalizeSettings({ renderMode: "vr" }).renderMode, "auto");
  const resolved = resolveEffects({ ...DEFAULT_SETTINGS, renderMode: "2d" }, false);
  assert.equal(resolved.renderMode, "2d");
});

test("WebGL dust budget is larger than the 2D canvas budget and scales with density", () => {
  const sparse = resolveEffects(
    { ...DEFAULT_SETTINGS, quality: "balanced", density: 0.2 },
    false,
  );
  const dense = resolveEffects(
    { ...DEFAULT_SETTINGS, quality: "high", density: 1 },
    false,
  );
  assert.ok(sparse.sceneDust >= sparse.dustCount);
  assert.ok(dense.sceneDust > sparse.sceneDust);
  const low = resolveEffects({ ...DEFAULT_SETTINGS, quality: "low", density: 0 }, false);
  assert.ok(low.sceneDust < dense.sceneDust);
});
