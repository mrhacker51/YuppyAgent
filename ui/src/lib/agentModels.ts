/**
 * Model catalog + per-agent model overrides.
 *
 * These are the models the Evren gateway actually serves (verified against
 * `/v1/models` and the Codex model catalog), not a made-up list.
 *
 * An override affects **new work**: it is written into `TaskSpecDto.model`,
 * which the bridge passes to the headless runner. A seat that is already
 * running keeps the model its CLI started with — the UI says so instead of
 * pretending a live PTY can be reconfigured mid-flight.
 */
import { useEffect, useState } from "react";

export interface ModelInfo {
  id: string;
  label: string;
  /** context window in tokens, from the gateway catalog */
  ctx: number;
  note?: string;
}

export const MODELS: readonly ModelInfo[] = [
  { id: "deepseek-v4.1-flash", label: "DeepSeek V4.1 Flash", ctx: 1_048_576, note: "1M · varsayılan" },
  { id: "mimo-v2.6-pro", label: "MiMo V2.6 Pro", ctx: 1_048_576, note: "1M" },
  { id: "glm-5.3", label: "GLM-5.3", ctx: 524_288, note: "512K" },
  { id: "qwen3.8-flash-next", label: "Qwen3.8 Flash Next", ctx: 262_144, note: "256K" },
  { id: "gemma-4-31b", label: "Gemma 4 31B", ctx: 262_144, note: "küçük · hızlı" },
] as const;

const STORAGE_KEY = "yuppy.agent.models.v1";

export type ModelMap = Record<string, string>;

function read(): ModelMap {
  if (typeof window === "undefined") return {};
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    if (!parsed || typeof parsed !== "object") return {};
    const out: ModelMap = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (typeof v === "string" && MODELS.some((m) => m.id === v)) out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

function write(map: ModelMap) {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
  } catch {
    // presentation only
  }
}

/** Per-agent model overrides, shared by the header strip and the composer. */
export function useAgentModels() {
  const [map, setMap] = useState<ModelMap>({});
  useEffect(() => {
    queueMicrotask(() => setMap(read()));
  }, []);
  const setModel = (agentId: string, modelId: string | null) => {
    setMap((prev) => {
      const next = { ...prev };
      if (modelId) next[agentId] = modelId;
      else delete next[agentId];
      write(next);
      return next;
    });
  };
  return { map, setModel, reload: () => setMap(read()) };
}

/** Read the map outside React (composer submit path). */
export function readAgentModels(): ModelMap {
  return read();
}

/** Resolve the model an agent will use for the next task. */
export function modelForAgent(
  agentId: string,
  overrides: ModelMap,
  roleModel?: string | null,
): string | null {
  return overrides[agentId] ?? roleModel ?? null;
}

export function modelLabel(id: string | null | undefined): string {
  if (!id) return "CLI varsayılanı";
  return MODELS.find((m) => m.id === id)?.label ?? id;
}

export function modelCtx(id: string | null | undefined): number | null {
  if (!id) return null;
  return MODELS.find((m) => m.id === id)?.ctx ?? null;
}
