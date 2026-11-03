"use client";

import { useState } from "react";
import {
  Check,
  Cpu,
  Grid,
  Info,
  Link,
  RefreshCw,
  Settings2,
  TriangleAlert,
} from "lucide-react";
import { FormField, Select, Switch } from "fancy-ui-react";
import {
  SEAT_SIZE_CHOICES,
  useHudStore,
  type MatrixColumns,
  type SeatSize,
  type SeatStartup,
} from "@/lib/store";
import { useMounted } from "@/lib/useMounted";
import EffectsSettings from "../fancy/EffectsSettings";
import { Card, ViewShell } from "./shared";

const SETTINGS_STARTUP_OPTIONS: { value: SeatStartup; label: string }[] = [
  { value: "lead", label: "yalnız lead (önerilen)" },
  { value: "all", label: "tüm ajanlar (ağır)" },
  { value: "off", label: "kapalı" },
];

const STATUS_LABEL: Record<string, string> = {
  disconnected: "offline",
  connecting: "bağlanıyor…",
  authenticating: "kimlik doğrulanıyor…",
  connected: "bağlı",
  auth_failed: "token reddedildi",
  protocol_mismatch: "protokol uyumsuz",
};

const MATRIX_OPTIONS: { value: string; label: string }[] = [
  { value: "auto", label: "oto" },
  { value: "2", label: "2 kolon" },
  { value: "3", label: "3 kolon" },
  { value: "4", label: "4 kolon" },
];

function seatSizeValue(size: SeatSize): string {
  return size === "auto" ? "auto" : `${size.cols}x${size.rows}`;
}

/**
 * Settings module. Browser pairing lives here (the token is never rendered
 * back); Tauri is shell-paired and only offers reconnect. Layout reset is a
 * real action on the same persisted store the bridge restores from.
 */
export default function SettingsView() {
  const status = useHudStore((s) => s.status);
  const bridgeUrl = useHudStore((s) => s.bridgeUrl);
  const bridgeError = useHudStore((s) => s.bridgeError);
  const connect = useHudStore((s) => s.connect);
  const disconnect = useHudStore((s) => s.disconnect);
  const resetPanels = useHudStore((s) => s.resetPanels);
  const matrixColumns = useHudStore((s) => s.matrixColumns);
  const setMatrixColumns = useHudStore((s) => s.setMatrixColumns);
  const seatStartup = useHudStore((s) => s.seatStartup);
  const setSeatStartup = useHudStore((s) => s.setSeatStartup);
  const seatSizePreset = useHudStore((s) => s.seatSizePreset);
  const setSeatSizePreset = useHudStore((s) => s.setSeatSizePreset);
  const minimalHud = useHudStore((s) => s.minimalHud);
  const setMinimalHud = useHudStore((s) => s.setMinimalHud);
  const engine = useHudStore((s) => s.engineInfo);
  const agents = useHudStore((s) => s.agents);
  const mounted = useMounted();
  const desktopShell =
    mounted && typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
  const connected = status === "connected";

  const [urlDraft, setUrlDraft] = useState(bridgeUrl);
  const [token, setToken] = useState("");

  return (
    <ViewShell
      title="Ayarlar"
      kicker="bridge · düzen · bağımlılıklar"
      right={
        <span
          className={`flex items-center gap-1.5 border px-1.5 py-0.5 font-mono text-[8px] uppercase tracking-wider ${
            connected
              ? "border-ok/30 text-ok"
              : status === "connecting" || status === "authenticating"
                ? "border-warn/30 text-warn"
                : "border-danger/30 text-danger"
          }`}
        >
          <span
            className={`size-1.5 rounded-full ${
              connected ? "bg-ok" : status === "connecting" ? "bg-warn animate-pulse" : "bg-danger"
            }`}
          />
          {STATUS_LABEL[status] ?? status}
        </span>
      }
      footer={
        <>
          <Settings2 size={9} aria-hidden />
          <span>token asla geri gösterilmez · masaüstünde shell tarafından yönetilir</span>
        </>
      }
    >
      <div className="grid gap-1 p-1 xl:grid-cols-2">
        <Card title="Bridge bağlantısı" sub={desktopShell ? "Tauri shell" : "tarayıcı eşleştirme"}>
          <form
            className="space-y-1.5 p-2"
            onSubmit={(e) => {
              e.preventDefault();
              try {
                if (!desktopShell && token.trim()) {
                  localStorage.setItem("yuppy.bridge.token", token.trim());
                }
              } catch {
                // Storage may be unavailable; the in-memory connect still works.
              }
              connect(urlDraft.trim() || undefined, token.trim() || undefined);
              setToken("");
            }}
          >
            <label className="block">
              <span className="font-mono text-[8px] uppercase tracking-wider text-text-lo">
                bridge url
              </span>
              <input
                value={urlDraft}
                onChange={(e) => setUrlDraft(e.target.value)}
                disabled={desktopShell}
                placeholder="ws://127.0.0.1:9090"
                aria-label="Bridge WebSocket URL"
                className="mt-0.5 h-7 w-full border border-line bg-bg-0 px-1.5 font-mono text-[10px] text-text-hi outline-none placeholder:text-text-lo focus-visible:border-line-strong disabled:cursor-not-allowed disabled:text-text-lo"
              />
            </label>

            {!desktopShell && (
              <label className="block">
                <span className="font-mono text-[8px] uppercase tracking-wider text-text-lo">
                  token
                </span>
                <input
                  type="password"
                  value={token}
                  onChange={(e) => setToken(e.target.value)}
                  placeholder="yuppy bridge çıktısındaki token"
                  aria-label="Bridge token"
                  className="mt-0.5 h-7 w-full border border-line bg-bg-0 px-1.5 font-mono text-[10px] text-text-hi outline-none placeholder:text-text-lo focus-visible:border-line-strong"
                />
              </label>
            )}

            <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
              <button
                type="submit"
                className="flex items-center gap-1 border border-accent/40 bg-accent-dim px-2 py-1 font-mono text-[8px] uppercase tracking-wider text-accent transition-colors hover:border-accent/70 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/50"
              >
                <Link size={8} aria-hidden />
                {connected ? "yeniden bağlan" : "bağlan"}
              </button>
              <button
                type="button"
                onClick={disconnect}
                disabled={!connected}
                className="flex items-center gap-1 border border-line px-2 py-1 font-mono text-[8px] uppercase tracking-wider text-text-mid transition-colors hover:border-danger/40 hover:text-danger disabled:cursor-not-allowed disabled:border-line/60 disabled:text-text-lo/60 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/50"
              >
                <RefreshCw size={8} aria-hidden /> bağlantıyı kes
              </button>
              {desktopShell && (
                <button
                  type="button"
                  onClick={() => connect()}
                  className="flex items-center gap-1 border border-line px-2 py-1 font-mono text-[8px] uppercase tracking-wider text-text-mid transition-colors hover:border-line-strong hover:text-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/50"
                >
                  <RefreshCw size={8} aria-hidden /> shell oturumu
                </button>
              )}
            </div>

            {desktopShell && (
              <p className="font-mono text-[8px] leading-relaxed text-text-lo">
                Masaüstü uygulamasında port ve token Tauri tarafından üretilir; bu alanlar
                değiştirilemez. Yeni token için uygulamayı yeniden başlat veya shell
                oturumunu yenile.
              </p>
            )}
            {bridgeError && (
              <p className="flex items-start gap-1.5 border border-danger/25 bg-danger/[0.05] px-1.5 py-1 font-mono text-[8px] leading-relaxed text-danger">
                <TriangleAlert size={9} className="mt-0.5 shrink-0" aria-hidden />
                {bridgeError}
              </p>
            )}
          </form>
        </Card>

        <Card title="Arayüz düzeni" sub="kalıcı">
          <div className="space-y-2 p-2">
            <div className="grid gap-1.5 sm:grid-cols-2">
              <FormField label="terminal matris kolonları">
                <Select
                  options={MATRIX_OPTIONS}
                  value={String(matrixColumns)}
                  onValueChange={(value) =>
                    setMatrixColumns(
                      value === "auto" ? "auto" : (Number(value) as MatrixColumns),
                    )
                  }
                  label="Terminal matris kolonları"
                  className="w-full"
                />
              </FormField>

              <FormField label="koltuk boyutu" description="pty yeniden akıtılır">
                <Select
                  options={SEAT_SIZE_CHOICES.map((choice) => ({
                    value: seatSizeValue(choice.value),
                    label: choice.label,
                  }))}
                  value={seatSizeValue(seatSizePreset)}
                  onValueChange={(value) => {
                    const choice = SEAT_SIZE_CHOICES.find(
                      (candidate) => seatSizeValue(candidate.value) === value,
                    );
                    if (choice) setSeatSizePreset(choice.value);
                  }}
                  label="Koltuk boyutu"
                  className="w-full"
                />
              </FormField>

              <FormField label="açılışta koltuklar" className="sm:col-span-2">
                <Select
                  options={SETTINGS_STARTUP_OPTIONS}
                  value={seatStartup}
                  onValueChange={(value) => setSeatStartup(value as SeatStartup)}
                  label="Açılışta açılacak koltuklar"
                  className="w-full"
                />
              </FormField>

              <FormField
                label="minimal HUD"
                description="yoğun terminal görünümü"
                className="sm:col-span-2"
              >
                <Switch
                  checked={minimalHud}
                  onCheckedChange={setMinimalHud}
                  size="sm"
                  label="Minimal HUD"
                >
                  durum çubuğunu ve dekoratif katmanları azalt
                </Switch>
              </FormField>
            </div>

            <p className="font-mono text-[8px] leading-relaxed text-text-lo">
              {seatStartup === "lead" &&
                "varsayılan: yalnızca seçili takımın lead Claude PTY'si açılır. Ajanlar arka planda (claude -p) çalışır, çıktıları kartlarına akar; bir ajanın terminali yalnızca kartındaki “terminal aç” ile açılır."}
              {seatStartup === "off" &&
                "hiçbir PTY kendiliğinden açılmaz, lead dahil; ana komut penceresinden elle başlatırsın."}
            </p>

            {seatStartup === "all" && (
              <p className="flex items-start gap-1.5 rounded-[6px] border border-warn/35 bg-warn/[0.06] px-2 py-1.5 font-mono text-[8px] leading-relaxed text-warn">
                <TriangleAlert size={10} className="mt-px shrink-0" aria-hidden />
                Uyarı: her takım rolü için ayrı etkileşimli Claude Code açılır. Her biri gerçek süreç
                ve yüzlerce MB RAM demek; açılış ve arayüz belirgin şekilde yavaşlar. Yalnızca güçlü
                makinede ve gerçekten gerekiyorsa kullan.
              </p>
            )}

            <div className="flex items-center gap-1.5 border-t border-line/60 pt-2">
              <Grid size={10} className="text-text-lo" aria-hidden />
              <p className="min-w-0 flex-1 font-mono text-[8px] leading-relaxed text-text-lo">
                Paneller, dock yüksekliği ve matris kolonları kalıcıdır; bridge yeniden
                başladığında geri yüklenir.
              </p>
              <button
                type="button"
                onClick={() => {
                  resetPanels();
                  setMatrixColumns("auto");
                }}
                className="flex shrink-0 items-center gap-1 border border-line px-1.5 py-1 font-mono text-[8px] uppercase tracking-wider text-text-mid transition-colors hover:border-warn/40 hover:text-warn focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/50"
              >
                <RefreshCw size={8} aria-hidden /> sıfırla
              </button>
            </div>

            <div className="flex items-start gap-1.5 border-t border-line/60 pt-2 font-mono text-[8px] leading-relaxed text-text-lo">
              <Check size={9} className="mt-0.5 shrink-0 text-ok/80" aria-hidden />
              Aynı CLI için ikinci bir PTY açılmaz; “yeniden başlat” önce eski süreci kapatır.
            </div>
          </div>
        </Card>

        <EffectsSettings />

        <Card title="Harici bağımlılıklar" sub="PATH taraması">
          <div className="divide-y divide-line/50">
            {agents.map((agent) => (
              <div key={agent.id} className="px-2 py-1.5">
                <div className="flex items-center gap-1.5">
                  <Cpu
                    size={9}
                    className={agent.available ? "text-accent/80" : "text-danger/70"}
                    aria-hidden
                  />
                  <span className="min-w-0 flex-1 truncate text-[10px] text-text-mid">
                    {agent.display_name}
                  </span>
                  <span className="font-mono text-[8px] text-text-lo">
                    {agent.version ?? "sürüm ?"}
                  </span>
                  <span
                    className={`border px-1 py-px font-mono text-[8px] uppercase tracking-wider ${
                      agent.available ? "border-ok/25 text-ok" : "border-danger/30 text-danger"
                    }`}
                  >
                    {agent.available ? "hazır" : "yok"}
                  </span>
                </div>
                <div className="mt-0.5 font-mono text-[8px] text-text-lo">
                  {agent.id}
                  {!agent.available && agent.install_hint ? ` · ${agent.install_hint}` : ""}
                </div>
              </div>
            ))}
            {agents.length === 0 && (
              <p className="px-2 py-3 font-mono text-[9px] text-text-lo">
                CLI envanteri yok — bridge bağlantısını denetle.
              </p>
            )}
            <div className="flex items-start gap-1.5 px-2 py-1.5 font-mono text-[8px] leading-relaxed text-text-lo">
              <Info size={9} className="mt-0.5 shrink-0 text-accent/70" aria-hidden />
              Tüm ajanlar Claude Code ile çalışır; kurulum ve ayarları değiştirilmez. Mevcut Lisans Ofisi
              gateway yapılandırması olduğu gibi kullanılır.
            </div>
          </div>
        </Card>

        <Card title="Hakkında" sub="salt okunur">
          <div className="divide-y divide-line/50 font-mono text-[9px]">
            <div className="flex items-center justify-between px-2 py-1.5">
              <span className="text-text-lo">uygulama</span>
              <span className="text-text-mid">
                YuppyCode {process.env.NEXT_PUBLIC_APP_VERSION ?? "0.1.0"}
              </span>
            </div>
            <div className="flex items-center justify-between px-2 py-1.5">
              <span className="text-text-lo">protokol</span>
              <span className="text-text-mid">bridge v2 · WebSocket + token</span>
            </div>
            <div className="flex items-center justify-between px-2 py-1.5">
              <span className="text-text-lo">çalışma alanı</span>
              <span className="max-w-[70%] truncate text-text-mid" title={engine?.workspace}>
                {engine?.workspace ?? "—"}
              </span>
            </div>
            <div className="flex items-center justify-between px-2 py-1.5">
              <span className="text-text-lo">branch</span>
              <span className="text-text-mid">{engine?.git_branch ?? "—"}</span>
            </div>
            <div className="flex items-center justify-between px-2 py-1.5">
              <span className="text-text-lo">token kaynağı</span>
              <span className="text-text-mid">
                {desktopShell ? "Tauri shell (bellek)" : "tarayıcı localStorage"}
              </span>
            </div>
            <div className="px-2 py-1.5 text-[8px] leading-relaxed text-text-lo">
              Arayüz yalnızca bridge verisiyle çalışır. Sohbet, dosya tarayıcı, bellek CRUD,
              beceri editörü ve gömülü kod editörü bu sürümde yoktur; ilgili sekmeler bunu
              açıkça belirtir.
            </div>
          </div>
        </Card>
      </div>
    </ViewShell>
  );
}
