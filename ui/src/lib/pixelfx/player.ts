/**
 * Tiny runtime for the vendored pixelfx effects (MIT, patch-gg/pixelfx).
 *
 * An effect draws into two pixel buffers (color + additive light). `FxPlayer`
 * owns one effect instance and one offscreen canvas at the effect's native
 * resolution, then blits it — nearest-neighbour — into any destination. That
 * keeps the pixel grid crisp at 1×, 2× or 3× and lets the office clip the same
 * frame into five window panes without re-rendering the sky.
 */
import { clearFrame, composite as rawComposite, createFrame, createFx } from "./core/index.js";

// The JS core infers `bg` as null-only (no JSDoc); the real signature accepts a
// packed color number too, which is what the canvas background needs.
const composite = rawComposite as unknown as (
  frame: unknown,
  out: Uint8ClampedArray,
  bg: number | null,
) => void;

export interface FxMeta {
  size?: [number, number];
  origin?: [number, number];
  duration?: number;
  loop?: boolean;
}

export interface FxModule {
  meta?: FxMeta;
  create?: (options: Record<string, unknown>) => unknown;
  draw?: unknown;
}

export class FxPlayer {
  readonly width: number;
  readonly height: number;
  private readonly frame: ReturnType<typeof createFrame>;
  private readonly fx: ReturnType<typeof createFx>;
  private readonly image: ImageData;
  private readonly scratch: HTMLCanvasElement;
  private readonly sctx: CanvasRenderingContext2D;
  private prepared = false;

  constructor(
    mod: FxModule,
    options: Record<string, unknown>,
    width: number,
    height: number,
  ) {
    this.width = width;
    this.height = height;
    const meta = mod.meta ?? {};
    this.frame = createFrame(width, height);
    this.fx = createFx(mod, {
      // Effects draw in local coordinates centred on their origin; place that
      // origin at the canvas origin so the whole frame is covered.
      x: meta.origin?.[0] ?? 0,
      y: meta.origin?.[1] ?? 0,
      ...options,
    });
    this.image = new ImageData(width, height);
    this.scratch = document.createElement("canvas");
    this.scratch.width = width;
    this.scratch.height = height;
    const sctx = this.scratch.getContext("2d");
    if (!sctx) throw new Error("pixelfx: 2d context unavailable");
    this.sctx = sctx;
    this.sctx.imageSmoothingEnabled = false;
  }

  update(dt: number) {
    this.fx.update(dt);
    this.prepared = false;
  }

  done(): boolean {
    return this.fx.done();
  }

  stop() {
    this.fx.stop();
  }

  /** Composite color + light into the offscreen canvas (idempotent per update). */
  prepare(background: number | null = null) {
    if (this.prepared) return this.scratch;
    clearFrame(this.frame);
    this.fx.draw(this.frame, "back");
    this.fx.draw(this.frame, "front");
    composite(this.frame, this.image.data, background);
    this.sctx.putImageData(this.image, 0, 0);
    this.prepared = true;
    return this.scratch;
  }

  /** Blit a source crop of the effect into a destination rect, pixelated. */
  paint(
    ctx: CanvasRenderingContext2D,
    sx: number,
    sy: number,
    sw: number,
    sh: number,
    dx: number,
    dy: number,
    dw: number,
    dh: number,
    background: number | null = null,
  ) {
    const canvas = this.prepare(background);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(canvas, sx, sy, sw, sh, dx, dy, dw, dh);
  }
}
