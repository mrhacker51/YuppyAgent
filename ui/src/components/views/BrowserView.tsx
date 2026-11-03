"use client";

import { useMemo, useState } from "react";
import { ExternalLink, Globe, History, Pin, RotateCw, TriangleAlert } from "lucide-react";
import { useHudStore } from "@/lib/store";
import MissionConsole from "../MissionConsole";
import {
  extractUrls,
  loadHistory,
  loadPins,
  normalizeUrl,
  openExternal,
  pushHistory,
  togglePin,
} from "@/lib/browser";

/** The local dev ports the agents almost always use. Clicking one opens it. */
const LOCAL_PORTS = [3000, 3434, 4321, 5173, 8000, 8080] as const;
const isDesktop = () => typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
const isLocalUrl = (url: string | null) =>
  !!url && /^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(:|\/|$)/i.test(url);

/**
 * Tarayıcı sekmesi.
 *
 * Sol kolon: ajan sohbeti (MissionConsole — tek ve gerçek sohbet yüzeyi;
 * prompt oraya yazılır, koltuk ekranları oraya akar).
 *
 * Sağ kolon: gerçek tarayıcı paneli. Adres çubuğundan bir URL açılır;
 * "dışta aç" sistem tarayıcısında (Firefox/Chrome) açar. "önizle" aynı URL'yi
 * gömülü iframe'de gösterir. Sitelerin X-Frame-Options'ı ve masaüstü kabuğunun
 * CSP'si (frame-src: yalnızca 'self') iframe'i engelleyebilir; o durumda sekme
 * boş kalır ve kullanıcıya bunu söyler — asla sahte sayfa çizmez.
 */
export default function BrowserView() {
  const logs = useHudStore((s) => s.logs);
  const tasks = useHudStore((s) => s.tasks);
  const [address, setAddress] = useState("");
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [pins, setPins] = useState<string[]>(() => loadPins());
  const [history, setHistory] = useState<string[]>(() => loadHistory());
  const [note, setNote] = useState<string | null>(null);
  const [previewKey, setPreviewKey] = useState(0);
  const desktop = isDesktop();

  // URLs that actually appeared in backend output (logs + task detail).
  const seenUrls = useMemo(() => {
    const out: string[] = [];
    const seen = new Set<string>();
    const feed = [...logs.map((l) => l.message), ...Object.values(tasks).map((t) => `${t.title} ${t.detail ?? ""}`)];
    for (const text of feed) {
      for (const u of extractUrls(text)) {
        if (!seen.has(u)) {
          seen.add(u);
          out.unshift(u);
        }
      }
    }
    return out.slice(0, 8);
  }, [logs, tasks]);

  const openUrl = async (raw: string) => {
    const url = normalizeUrl(raw);
    if (!url) {
      setNote(`Geçersiz URL: ${raw.slice(0, 60)}`);
      return;
    }
    setHistory(pushHistory(url));
    const how = await openExternal(url);
    setNote(
      how === "window"
        ? `${url} — yeni sekmede/sistem tarayıcısında açıldı`
        : how === "tauri"
          ? `${url} — sistem tarayıcısında açıldı`
          : `${url} — pencere açılamadı, URL panoya kopyalandı`,
    );
  };

  const preview = (raw: string) => {
    const url = normalizeUrl(raw);
    if (!url) {
      setNote(`Geçersiz URL: ${raw.slice(0, 60)}`);
      return;
    }
    setHistory(pushHistory(url));
    setPreviewUrl(url);
    setPreviewKey((k) => k + 1);
  };

  const chip = (url: string, pinned: boolean) => (
    <span
      key={url}
      className="flex max-w-full items-center gap-1 border border-line bg-bg-2 px-1.5 py-0.5 font-mono text-[8px] text-text-mid"
    >
      <button
        type="button"
        onClick={() => openUrl(url)}
        title={`${url} — dış tarayıcıda aç`}
        className="truncate text-left text-text-mid transition-colors hover:text-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/60"
      >
        {url.replace(/^https?:\/\//, "")}
      </button>
      <button
        type="button"
        onClick={() => preview(url)}
        title="Bu panelde önizle"
        aria-label={`${url} önizle`}
        className="shrink-0 text-text-lo hover:text-accent focus-visible:outline-none"
      >
        <Globe size={9} aria-hidden />
      </button>
      <button
        type="button"
        onClick={() => setPins(togglePin(url))}
        title={pinned ? "Pin'i kaldır" : "Sabitle"}
        aria-label={pinned ? `${url} pinli` : `${url} pinle`}
        className={`shrink-0 focus-visible:outline-none ${pinned ? "text-accent" : "text-text-lo hover:text-text-mid"}`}
      >
        <Pin size={9} aria-hidden />
      </button>
    </span>
  );

  return (
    <div className="grid h-full min-h-0 grid-cols-1 grid-rows-[minmax(0,1fr)_minmax(320px,1.2fr)] gap-1.5 overflow-hidden lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)] lg:grid-rows-1">
      {/* SOL — ajan sohbeti (ana sayfadaki aynı sohbet yüzeyi) */}
      <div className="flex h-full min-h-0 flex-col overflow-hidden">
        <MissionConsole />
      </div>

      {/* SAĞ — tarayıcı paneli */}
      <section className="flex h-full min-h-0 flex-col overflow-hidden border border-line">
        <header className="deck-rail flex h-7 shrink-0 items-center gap-2 border-b border-line bg-bg-1/80 px-2">
          <Globe size={11} className="text-accent" aria-hidden />
          <span className="font-mono text-[9px] uppercase tracking-[0.18em] text-text-hi">Tarayıcı</span>
          <form
            className="ml-1 flex min-w-0 flex-1 items-center gap-1"
            onSubmit={(e) => {
              e.preventDefault();
              // Local URLs are agents building sites — show them right here.
              // External websites are opened in the real browser.
              const url = normalizeUrl(address);
              if (url && isLocalUrl(url)) preview(address);
              else void openUrl(address);
            }}
          >
            <input
              value={address}
              onChange={(e) => setAddress(e.target.value)}
              placeholder="localhost:3000 — ↵ panelde gösterir (yerel)"
              aria-label="Adres (URL)"
              spellCheck={false}
              className="h-5 min-w-0 flex-1 border border-line bg-bg-2 px-1.5 font-mono text-[9px] text-text-hi outline-none placeholder:text-text-lo focus-visible:border-accent/50"
            />
            <button
              type="button"
              onClick={() => preview(address)}
              title="Bu panelde gömülü önizleme (yerel siteler için)"
              className="flex h-5 shrink-0 items-center gap-1 border border-accent/50 bg-accent/10 px-1.5 font-mono text-[8px] uppercase tracking-wider text-accent transition-colors hover:border-accent hover:bg-accent/20 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/60"
            >
              <Globe size={8} aria-hidden />
              <span className="hidden sm:inline">önizle</span>
            </button>
            <button
              type="button"
              onClick={() => void openUrl(address)}
              title="Sistem tarayıcısında aç (Firefox/Chrome)"
              className="flex h-5 shrink-0 items-center gap-1 border border-line px-1.5 font-mono text-[8px] uppercase tracking-wider text-text-mid transition-colors hover:border-line-strong hover:text-text-hi focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/60"
            >
              <ExternalLink size={8} aria-hidden />
              <span className="hidden sm:inline">dışta aç</span>
            </button>
          </form>
        </header>

        <div className="flex shrink-0 flex-wrap items-center gap-1 border-b border-line/60 px-2 py-1">
          <span className="font-mono text-[7.5px] uppercase tracking-wider text-text-lo">local</span>
          {LOCAL_PORTS.map((p) => (
            <button
              key={p}
              type="button"
              onClick={() => preview(`http://localhost:${p}`)}
              title={`http://localhost:${p} — panelde önizle`}
              className="border border-line/70 px-1.5 py-0.5 font-mono text-[8px] tabular-nums text-text-mid transition-colors hover:border-accent/40 hover:text-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/60"
            >
              :{p}
            </button>
          ))}
          {seenUrls.map((u) => chip(u, pins.includes(u)))}
          {history.length > 0 && (
            <>
              <span className="ml-1 flex items-center gap-0.5 font-mono text-[7.5px] uppercase tracking-wider text-text-lo">
                <History size={7} aria-hidden /> geçmiş
              </span>
              {history.slice(0, 6).map((u) => chip(u, pins.includes(u)))}
            </>
          )}
          {pins.length > 0 && (
            <>
              <span className="ml-1 flex items-center gap-0.5 font-mono text-[7.5px] uppercase tracking-wider text-accent">
                <Pin size={7} aria-hidden /> sabit
              </span>
              {pins.map((u) => chip(u, true))}
            </>
          )}
          {seenUrls.length === 0 && pins.length === 0 && (
            <span className="font-mono text-[7.5px] text-text-lo/70">
              ajan bir URL loglarsa burada tıklanabilir olur
            </span>
          )}
        </div>

        {note && (
          <p className="shrink-0 border-b border-line/60 bg-bg-1 px-2 py-0.5 font-mono text-[8px] text-text-mid">
            {note}
          </p>
        )}

        {desktop && previewUrl && !isLocalUrl(previewUrl) && (
          <p className="flex shrink-0 items-center gap-1 border-b border-warn/20 bg-warn/[0.06] px-2 py-1 font-mono text-[8px] text-warn/90">
            <TriangleAlert size={9} className="shrink-0" aria-hidden />
            Masaüstü CSP’si yalnızca local önizlemeye izin verir — bu siteyi “dışta aç”la aç.
          </p>
        )}

        <div className="relative min-h-0 flex-1 bg-bg-0">
          {previewUrl ? (
            <>
              <div className="flex h-6 shrink-0 items-center gap-1 border-b border-line bg-bg-1 px-2 font-mono text-[8px] text-text-lo">
                <span className="min-w-0 truncate text-text-mid">{previewUrl}</span>
                <button
                  type="button"
                  onClick={() => setPreviewKey((k) => k + 1)}
                  title="Önizlemeyi yenile"
                  aria-label="Önizlemeyi yenile"
                  className="ml-auto shrink-0 border border-line px-1 py-px uppercase hover:border-line-strong hover:text-text-hi focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/60"
                >
                  <RotateCw size={8} aria-hidden />
                </button>
                <button
                  type="button"
                  onClick={() => setPreviewUrl(null)}
                  className="shrink-0 border border-line px-1 py-px uppercase hover:border-line-strong hover:text-text-hi focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/60"
                >
                  kapat
                </button>
                <button
                  type="button"
                  onClick={() => void openUrl(previewUrl)}
                  title="Dış tarayıcıda aç"
                  aria-label="Dış tarayıcıda aç"
                  className="shrink-0 border border-accent/50 px-1 py-px uppercase text-accent hover:bg-accent/10 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/60"
                >
                  <ExternalLink size={8} aria-hidden />
                </button>
              </div>
              {desktop && !isLocalUrl(previewUrl) ? (
                <div className="flex h-[calc(100%-24px)] flex-col items-center justify-center gap-2 p-4 text-center">
                  <TriangleAlert size={22} className="text-warn/80" aria-hidden />
                  <p className="max-w-md font-mono text-[9.5px] leading-relaxed text-text-mid">
                    Masaüstü CSP’si yalnızca local önizlemeye izin verir.
                  </p>
                  <button
                    type="button"
                    onClick={() => void openUrl(previewUrl)}
                    className="flex h-6 items-center gap-1 border border-accent/50 bg-accent/10 px-2 font-mono text-[9px] uppercase tracking-wider text-accent hover:bg-accent/20 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/60"
                  >
                    <ExternalLink size={9} aria-hidden />
                    dış tarayıcıda aç
                  </button>
                </div>
              ) : (
                <iframe
                  key={previewKey}
                  src={previewUrl}
                  title={`Önizleme: ${previewUrl}`}
                  sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox"
                  className="h-[calc(100%-24px)] w-full border-0 bg-white"
                />
              )}
            </>
          ) : (
            <div className="flex h-full flex-col items-center justify-center gap-2 p-4 text-center">
              <Globe size={24} className="text-text-lo/50" aria-hidden />
              <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-text-mid">
                önizleme kapalı
              </p>
              <p className="max-w-md font-mono text-[9px] leading-relaxed text-text-lo">
                Bir URL yazıp <span className="text-accent">önizle</span>ye bas — ajanların başlattığı
                dev server’ı (örn. <span className="text-accent">:3000</span>) burada canlı test et.{" "}
                <span className="text-accent">dışta aç</span> aynı sayfayı Firefox/Chrome’da açar.{" "}
                {!desktop && "X-Frame-Options gönderen siteler (github.com vb.) bu panelde görünmez; onlar için “dışta aç” kullan."}
              </p>
              <button
                type="button"
                onClick={() => preview("http://localhost:3434/")}
                className="mt-1 border border-line px-2 py-1 font-mono text-[8px] uppercase tracking-wider text-text-mid hover:border-accent/40 hover:text-accent focus-visible:outline-none"
              >
                localhost:3434’ü önizle
              </button>
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
