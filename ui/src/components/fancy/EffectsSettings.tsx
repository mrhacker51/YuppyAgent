"use client";

import { Gauge, RotateCcw, Sparkles } from "lucide-react";
import { FormField, Select, Slider, Switch } from "fancy-ui-react";
import {
  useEffectsStore,
  type EffectSettings,
  type QualityPreset,
  type ReducedMotionPref,
  type RenderMode,
} from "@/lib/effects";
import { Card } from "../views/shared";

const QUALITY_OPTIONS = [
  { value: "low", label: "düşük" },
  { value: "balanced", label: "dengeli" },
  { value: "high", label: "yüksek" },
];

const RENDER_OPTIONS = [
  { value: "auto", label: "otomatik" },
  { value: "3d", label: "3B evren" },
  { value: "2d", label: "2B ağ" },
];

const REDUCED_OPTIONS = [
  { value: "auto", label: "sistem" },
  { value: "on", label: "açık" },
  { value: "off", label: "kapalı" },
];

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

/**
 * Effect settings live in the same Settings module as the bridge pairing and
 * are persisted by `useEffectsStore` (localStorage `yuppy.effects.v1`).
 * Turning effects off only changes rendering — the network, tasks and
 * terminals keep working exactly as before.
 */
export default function EffectsSettings() {
  const settings = useEffectsStore((s) => s.settings);
  const setSettings = useEffectsStore((s) => s.setSettings);
  const setQuality = useEffectsStore((s) => s.setQuality);
  const reset = useEffectsStore((s) => s.reset);
  const disabled = !settings.enabled;

  return (
    <Card title="Görsel efektler" sub="kalıcı · yalnızca sunum">
      <div className={`space-y-2 p-2 ${disabled ? "opacity-55" : ""}`}>
        <Switch
          checked={settings.enabled}
          onCheckedChange={(enabled) => setSettings({ enabled })}
          size="sm"
        >
          <span className="flex min-w-0 flex-col text-left">
            <span className="text-[9px] text-text-mid">Efektleri etkinleştir</span>
            <span className="font-mono text-[7px] uppercase tracking-wider text-text-lo/70">
              ana anahtar — ağ ve terminaller çalışmaya devam eder
            </span>
          </span>
        </Switch>

        <div className="grid gap-1.5 sm:grid-cols-2">
          <FormField label="kalite ön ayarı">
            <Select
              options={QUALITY_OPTIONS}
              value={settings.quality}
              onValueChange={(value) => setQuality(value as QualityPreset)}
              label="Kalite ön ayarı"
              className="w-full"
            />
          </FormField>

          <FormField
            label="ağ sahnesi"
            description="otomatik: webgl varsa 3B, yoksa 2B"
          >
            <Select
              options={RENDER_OPTIONS}
              value={settings.renderMode}
              onValueChange={(value) => setSettings({ renderMode: value as RenderMode })}
              label="Ağ sahnesi"
              className="w-full"
            />
          </FormField>
        </div>

        <div className="grid grid-cols-1 gap-1 sm:grid-cols-2">
          {TOGGLES.map((toggle) => (
            <div key={toggle.key} className="border border-line/70 px-1.5 py-1">
              <Switch
                checked={settings[toggle.key]}
                onCheckedChange={(checked) => setSettings({ [toggle.key]: checked })}
                size="sm"
              >
                <span className="flex min-w-0 flex-col text-left">
                  <span className="truncate text-[9px] text-text-mid">{toggle.label}</span>
                  <span className="truncate font-mono text-[7px] uppercase tracking-wider text-text-lo/70">
                    {toggle.hint}
                  </span>
                </span>
              </Switch>
            </div>
          ))}
        </div>

        <div className="space-y-1.5 border-t border-line/60 pt-2">
          <FormField label="parçacık yoğunluğu">
            <Slider
              value={settings.density}
              min={0}
              max={1}
              step={0.05}
              onValueChange={(density) => setSettings({ density })}
              label="Parçacık yoğunluğu"
              showValue
            />
          </FormField>
          <FormField label="animasyon hızı">
            <Slider
              value={settings.speed}
              min={0.5}
              max={2}
              step={0.05}
              onValueChange={(speed) => setSettings({ speed })}
              label="Animasyon hızı"
              showValue
            />
          </FormField>
          <FormField label="parlama (bloom)">
            <Slider
              value={settings.bloom}
              min={0}
              max={1}
              step={0.05}
              onValueChange={(bloom) => setSettings({ bloom })}
              label="Parlama"
              showValue
            />
          </FormField>
        </div>

        <div className="flex flex-wrap items-end gap-1.5 border-t border-line/60 pt-2">
          <FormField label="azaltılmış hareket" className="min-w-[150px] flex-1">
            <Select
              options={REDUCED_OPTIONS}
              value={settings.reducedMotion}
              onValueChange={(value) =>
                setSettings({ reducedMotion: value as ReducedMotionPref })
              }
              label="Azaltılmış hareket"
              className="w-full"
            />
          </FormField>
          <button
            type="button"
            onClick={reset}
            className="flex h-7 items-center gap-1 border border-line px-1.5 py-1 font-mono text-[8px] uppercase tracking-wider text-text-mid transition-colors hover:border-warn/40 hover:text-warn focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/50"
          >
            <RotateCcw size={8} aria-hidden /> varsayılan
          </button>
        </div>

        <p className="flex items-start gap-1.5 font-mono text-[8px] leading-relaxed text-text-lo/80">
          <Sparkles size={9} className="mt-0.5 shrink-0 text-accent/70" aria-hidden />
          Efektler gerçek bridge verisini (PTY oturumları, görev durumları, çakışmalar) izler;
          hiçbir metrik, mesaj veya ilerleme uydurulmaz. Tercihler bu tarayıcıda saklanır.
        </p>
        <p className="flex items-center gap-1.5 font-mono text-[7px] uppercase tracking-wider text-text-lo/60">
          <Gauge size={8} aria-hidden />
          kalite ön ayarı yoğunluk ve parlamayı da günceller
        </p>
      </div>
    </Card>
  );
}
