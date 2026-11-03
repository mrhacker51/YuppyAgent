"use client";

import { Gauge, RotateCcw, Sparkles } from "lucide-react";
import {
  useEffectsStore,
  type EffectSettings,
  type QualityPreset,
  type ReducedMotionPref,
  type RenderMode,
} from "@/lib/effects";
import { Card } from "./views/shared";

const QUALITY_LABEL: Record<QualityPreset, string> = {
  low: "düşük",
  balanced: "dengeli",
  high: "yüksek",
};

const REDUCED_LABEL: Record<ReducedMotionPref, string> = {
  auto: "sistem",
  on: "açık",
  off: "kapalı",
};

const RENDER_LABEL: Record<RenderMode, string> = {
  auto: "otomatik",
  "3d": "3B evren",
  "2d": "2B ağ",
};

type BoolKey = keyof Pick<
  EffectSettings,
  "ambient" | "connections" | "particles" | "nodeGlow" | "core" | "hud"
>;

const TOGGLES: Array<{ key: BoolKey; label: string; hint: string }> = [
  { key: "ambient", label: "Ortam parçacıkları", hint: "toz alanı + holografik ızgara" },
  { key: "connections", label: "Bağlantı animasyonu", hint: "çizim ve akış vurgusu" },
  { key: "particles", label: "Veri parçacıkları", hint: "bağlantı üzerinde ışık akışı" },
  { key: "nodeGlow", label: "Düğüm parlaması", hint: "nefes alma ve durum halkaları" },
  { key: "core", label: "Jarvis çekirdeği", hint: "halkalar, yörünge, nabız" },
  { key: "hud", label: "Radar + tarama", hint: "radar süpürme, scanline, huzme" },
];

function Toggle({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string;
  hint: string;
  checked: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className="flex items-center gap-2 border border-line/70 px-1.5 py-1 text-left transition-colors hover:border-line-strong focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/50"
    >
      <span
        className={`relative h-3 w-6 shrink-0 border transition-colors ${
          checked ? "border-accent/60 bg-accent/20" : "border-line bg-bg-0"
        }`}
        aria-hidden
      >
        <span
          className={`absolute top-1/2 size-1.5 -translate-y-1/2 transition-all ${
            checked ? "left-3.5 bg-accent" : "left-1 bg-text-lo/50"
          }`}
        />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[9px] text-text-mid">{label}</span>
        <span className="block truncate font-mono text-[7px] uppercase tracking-wider text-text-lo/70">
          {hint}
        </span>
      </span>
    </button>
  );
}

function Slider({
  label,
  value,
  onChange,
  min = 0,
  max = 1,
  step = 0.05,
  format,
}: {
  label: string;
  value: number;
  onChange: (next: number) => void;
  min?: number;
  max?: number;
  step?: number;
  format: (value: number) => string;
}) {
  return (
    <label className="block">
      <span className="flex items-center justify-between font-mono text-[8px] uppercase tracking-wider text-text-lo">
        <span>{label}</span>
        <span className="tabular-nums text-text-mid">{format(value)}</span>
      </span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        aria-label={label}
        className="mt-1 h-1 w-full cursor-pointer appearance-none bg-line accent-[color:var(--accent)]"
      />
    </label>
  );
}

/**
 * Effect settings live in the same Settings module as the bridge pairing and
 * are persisted by `useEffectsStore` (localStorage `yuppy.effects.v1`).
 * Turning effects off only changes rendering — the network, tasks and
 * terminals keep working exactly as before.
 */
export default function EffectsCard() {
  const settings = useEffectsStore((s) => s.settings);
  const setSettings = useEffectsStore((s) => s.setSettings);
  const setQuality = useEffectsStore((s) => s.setQuality);
  const reset = useEffectsStore((s) => s.reset);
  const disabled = !settings.enabled;

  return (
    <Card title="Görsel efektler" sub="kalıcı · yalnızca sunum">
      <div className={`space-y-2 p-2 ${disabled ? "opacity-55" : ""}`}>
        <Toggle
          label="Efektleri etkinleştir"
          hint="ana anahtar — ağ ve terminaller çalışmaya devam eder"
          checked={settings.enabled}
          onChange={(enabled) => setSettings({ enabled })}
        />

        <div>
          <div className="font-mono text-[8px] uppercase tracking-wider text-text-lo">
            kalite ön ayarı
          </div>
          <div
            className="mt-1 flex w-fit border border-line"
            role="group"
            aria-label="Kalite ön ayarı"
          >
            {(["low", "balanced", "high"] as const).map((preset) => (
              <button
                key={preset}
                type="button"
                onClick={() => setQuality(preset)}
                aria-pressed={settings.quality === preset}
                className={`h-6 border-l border-line px-2 font-mono text-[8px] uppercase tracking-wider transition-colors first:border-l-0 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-accent/60 ${
                  settings.quality === preset
                    ? "bg-accent/10 text-accent"
                    : "text-text-lo hover:bg-bg-2 hover:text-text-mid"
                }`}
              >
                {QUALITY_LABEL[preset]}
              </button>
            ))}
          </div>
        </div>

        <div>
          <div className="font-mono text-[8px] uppercase tracking-wider text-text-lo">
            ağ sahnesi
          </div>
          <div
            className="mt-1 flex w-full border border-line"
            role="group"
            aria-label="Ağ sahnesi"
          >
            {(["auto", "3d", "2d"] as const).map((mode) => (
              <button
                key={mode}
                type="button"
                onClick={() => setSettings({ renderMode: mode })}
                aria-pressed={settings.renderMode === mode}
                className={`h-6 flex-1 border-l border-line px-1.5 font-mono text-[8px] uppercase tracking-wider transition-colors first:border-l-0 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-accent/60 ${
                  settings.renderMode === mode
                    ? "bg-accent/10 text-accent"
                    : "text-text-lo hover:bg-bg-2 hover:text-text-mid"
                }`}
              >
                {RENDER_LABEL[mode]}
              </button>
            ))}
          </div>
          <p className="mt-1 font-mono text-[7px] uppercase tracking-wider text-text-lo/60">
            otomatik: webgl varsa 3B (three/r3f bloom) · yoksa 2B (react flow + pixi)
          </p>
        </div>

        <div className="grid grid-cols-1 gap-1 sm:grid-cols-2">
          {TOGGLES.map((toggle) => (
            <Toggle
              key={toggle.key}
              label={toggle.label}
              hint={toggle.hint}
              checked={settings[toggle.key]}
              onChange={(next) => setSettings({ [toggle.key]: next })}
            />
          ))}
        </div>

        <div className="space-y-1.5 border-t border-line/60 pt-2">
          <Slider
            label="parçacık yoğunluğu"
            value={settings.density}
            format={(v) => `${Math.round(v * 100)}%`}
            onChange={(density) => setSettings({ density })}
          />
          <Slider
            label="animasyon hızı"
            value={settings.speed}
            min={0.5}
            max={2}
            step={0.05}
            format={(v) => `${v.toFixed(2)}×`}
            onChange={(speed) => setSettings({ speed })}
          />
          <Slider
            label="parlama (bloom)"
            value={settings.bloom}
            format={(v) => `${Math.round(v * 100)}%`}
            onChange={(bloom) => setSettings({ bloom })}
          />
        </div>

        <div className="flex flex-wrap items-center gap-1.5 border-t border-line/60 pt-2">
          <Gauge size={9} className="text-text-lo" aria-hidden />
          <span className="font-mono text-[8px] uppercase tracking-wider text-text-lo">
            azaltılmış hareket
          </span>
          <div
            className="flex border border-line"
            role="group"
            aria-label="Azaltılmış hareket"
          >
            {(["auto", "on", "off"] as const).map((pref) => (
              <button
                key={pref}
                type="button"
                onClick={() => setSettings({ reducedMotion: pref })}
                aria-pressed={settings.reducedMotion === pref}
                className={`h-5 border-l border-line px-1.5 font-mono text-[8px] uppercase tracking-wider transition-colors first:border-l-0 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-accent/60 ${
                  settings.reducedMotion === pref
                    ? "bg-accent/10 text-accent"
                    : "text-text-lo hover:bg-bg-2 hover:text-text-mid"
                }`}
              >
                {REDUCED_LABEL[pref]}
              </button>
            ))}
          </div>
          <button
            type="button"
            onClick={reset}
            className="ml-auto flex items-center gap-1 border border-line px-1.5 py-1 font-mono text-[8px] uppercase tracking-wider text-text-mid transition-colors hover:border-warn/40 hover:text-warn focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/50"
          >
            <RotateCcw size={8} aria-hidden /> varsayılan
          </button>
        </div>

        <p className="flex items-start gap-1.5 font-mono text-[8px] leading-relaxed text-text-lo/80">
          <Sparkles size={9} className="mt-0.5 shrink-0 text-accent/70" aria-hidden />
          Efektler gerçek bridge verisini (PTY oturumları, görev durumları, çakışmalar) izler;
          hiçbir metrik, mesaj veya ilerleme uydurulmaz. Tercihler bu tarayıcıda saklanır.
        </p>
      </div>
    </Card>
  );
}
