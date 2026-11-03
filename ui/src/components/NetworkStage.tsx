"use client";

import dynamic from "next/dynamic";
import { AnimatePresence, motion } from "framer-motion";
import { Boxes, Orbit, TriangleAlert } from "lucide-react";
import {
  Component,
  useMemo,
  useState,
  useSyncExternalStore,
  type ErrorInfo,
  type ReactNode,
} from "react";
import { useEffectsStore } from "@/lib/effects";
import { useMounted } from "@/lib/useMounted";
import NetworkMap from "./NetworkMap";

const NetworkUniverse = dynamic(() => import("./universe/NetworkUniverse"), {
  ssr: false,
  loading: () => <StageLoading label="3B evren derleniyor…" />,
});

const FlowNetwork = dynamic(() => import("./universe/FlowNetwork"), {
  ssr: false,
  loading: () => <StageLoading label="2B görev ağı derleniyor…" />,
});

function StageLoading({ label }: { label: string }) {
  return (
    <div className="flex h-full w-full min-h-[260px] items-center justify-center border border-line bg-[#07080a]">
      <div className="flex flex-col items-center gap-2">
        <span className="relative flex size-8 items-center justify-center">
          <span className="absolute inset-0 animate-ping rounded-full border border-accent/30" />
          <Orbit size={16} className="text-accent" aria-hidden />
        </span>
        <span className="font-mono text-[9px] uppercase tracking-[0.18em] text-text-lo">
          {label}
        </span>
      </div>
    </div>
  );
}

function detectWebGL(): boolean {
  if (typeof document === "undefined") return false;
  try {
    const canvas = document.createElement("canvas");
    const gl =
      canvas.getContext("webgl2") ??
      canvas.getContext("webgl") ??
      canvas.getContext("experimental-webgl");
    return Boolean(gl);
  } catch {
    return false;
  }
}

/*
 * WebGL support is tested once per page: creating a throwaway canvas on every
 * render is both expensive and impure. The subscription never fires because a
 * device cannot gain a GPU mid-session; `useSyncExternalStore` still gives us
 * the SSR-safe `false` snapshot during hydration without a setState effect.
 */
let webglSupport: boolean | null = null;
const subscribeNothing = () => () => {};
function webglSnapshot(): boolean {
  if (webglSupport === null) webglSupport = detectWebGL();
  return webglSupport;
}
const webglServerSnapshot = () => false;

/**
 * Chooses the heaviest renderer the device can actually run.
 *
 *  - 3D: R3F/Three shader universe (WebGL2/WebGL1).
 *  - 2D: React Flow graph + PixiJS particle field (DOM/SVG + optional WebGL).
 *  - Canvas: the previous dependency-free renderer, kept as the honest
 *    fallback for reduced-motion/very old webviews.
 */
export default function NetworkStage() {
  const settings = useEffectsStore((s) => s.settings);
  const setSettings = useEffectsStore((s) => s.setSettings);
  const mounted = useMounted();
  const webgl = useSyncExternalStore(
    subscribeNothing,
    webglSnapshot,
    webglServerSnapshot,
  );
  // A failure belongs to the mode it happened in; switching modes gives the
  // new renderer a clean slate without a setState-in-effect reset.
  const [failure, setFailure] = useState<{ mode: string; failed: boolean } | null>(null);

  const requested = settings.renderMode;
  const mode: "3d" | "2d" = useMemo(() => {
    if (requested === "3d") return webgl ? "3d" : "2d";
    if (requested === "2d") return "2d";
    return webgl ? "3d" : "2d";
  }, [requested, webgl]);
  const failed = failure?.mode === mode && failure.failed;

  if (!mounted) return <StageLoading label="sahne hazırlanıyor…" />;

  if (settings.renderMode === "3d" && !webgl) {
    // A real capability message, not a silent downgrade.
    return (
      <div className="relative h-full w-full min-h-[260px]">
        <div className="absolute inset-x-0 top-0 z-20 flex items-center gap-1.5 border-b border-warn/25 bg-warn/[0.06] px-2 py-1 font-mono text-[8px] text-warn">
          <TriangleAlert size={9} aria-hidden />
          Bu webview WebGL başlatamadı — 2B React Flow moduna düşüldü.
        </div>
        <div className="h-full pt-6">
          <FlowNetwork />
        </div>
      </div>
    );
  }

  return (
    <div className="relative h-full w-full min-h-[260px]">
      <AnimatePresence mode="wait" initial={false}>
        <motion.div
          key={mode}
          initial={{ opacity: 0, scale: 0.985 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={{ opacity: 0, scale: 1.01 }}
          transition={{ duration: 0.28, ease: [0.2, 0.8, 0.2, 1] }}
          className="absolute inset-0"
        >
          {mode === "3d" ? (
            failed ? (
              <div className="h-full w-full">
                <NetworkMap />
              </div>
            ) : (
              <UniverseBoundary onFail={() => setFailure({ mode, failed: true })}>
                <NetworkUniverse />
              </UniverseBoundary>
            )
          ) : (
            <FlowNetwork />
          )}
        </motion.div>
      </AnimatePresence>

      <div
        className="absolute right-2 top-2 z-20 flex border border-line bg-bg-0/85 backdrop-blur-sm"
        role="group"
        aria-label="Ağ görünümü"
      >
        <button
          type="button"
          onClick={() => setSettings({ renderMode: "3d" })}
          disabled={!webgl}
          aria-pressed={mode === "3d"}
          title={webgl ? "3B WebGL evreni" : "WebGL kullanılamıyor"}
          className={`flex h-5 items-center gap-1 px-1.5 font-mono text-[8px] uppercase tracking-wider transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
            mode === "3d"
              ? "bg-accent/10 text-accent"
              : "text-text-lo hover:bg-bg-2 hover:text-text-mid"
          }`}
        >
          <Orbit size={8} aria-hidden /> 3D
        </button>
        <button
          type="button"
          onClick={() => setSettings({ renderMode: "2d" })}
          aria-pressed={mode === "2d"}
          title="2B React Flow görev ağı"
          className={`flex h-5 items-center gap-1 border-l border-line px-1.5 font-mono text-[8px] uppercase tracking-wider transition-colors ${
            mode === "2d"
              ? "bg-accent/10 text-accent"
              : "text-text-lo hover:bg-bg-2 hover:text-text-mid"
          }`}
        >
          <Boxes size={8} aria-hidden /> 2D
        </button>
      </div>

      {!webgl && settings.renderMode === "auto" && (
        <div className="pointer-events-none absolute bottom-1.5 right-2 z-10 font-mono text-[8px] uppercase tracking-wider text-text-lo/70">
          webgl yok · 2B mod
        </div>
      )}
    </div>
  );
}

/* Minimal error boundary: a broken WebGL context must never take the app
   down (Tauri webviews vary a lot). The 2D map takes over. */
class UniverseBoundary extends Component<
  { children: ReactNode; onFail: () => void },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(error: Error, info: ErrorInfo) {
    console.warn("NetworkUniverse failed, falling back to 2D:", error.message, info.componentStack);
    this.props.onFail();
  }
  render() {
    if (this.state.failed) return null;
    return this.props.children;
  }
}
