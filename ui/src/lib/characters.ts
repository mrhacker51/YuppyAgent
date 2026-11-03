import { useEffect, useState } from "react";
import { CHAR_BASES, charBaseFor } from "./officeScene";

/**
 * Agent characters — the little people that walk around the office.
 *
 * A character is one of the sprite bodies from the room art, not an identity:
 * the operator picks one per agent and the choice persists locally. When
 * nothing is chosen the body is derived from the agent id, except for the two
 * CLIs that should stay recognisable across a room (Claude and Codex).
 */

export interface CharacterLook {
  /** stable id used in storage and the picker */
  id: string;
  name: string;
  /** Sprite body name under `/office/characters/<sprite>-<facing>.png`. */
  sprite: string;
  /** Accent used for bubbles, chips and the picker ring. */
  accent: string;
}

export const CHARACTERS: readonly CharacterLook[] = [
  { id: "claude", name: "Claude", sprite: "Claude-1", accent: "#e08a5c" },
  { id: "dev", name: "Dev", sprite: "dev-1", accent: "#7dd3a0" },
  { id: "backend", name: "Backend", sprite: "dev-2", accent: "#5eead4" },
  { id: "frontend", name: "Frontend", sprite: "Frontend-dev-1", accent: "#8b9cf7" },
  { id: "security", name: "Security", sprite: "security-audit-1", accent: "#fb7185" },
  { id: "research", name: "Research", sprite: "explore-1", accent: "#fbbf24" },
  { id: "staff-a", name: "Staff A", sprite: "employee-1", accent: "#a78bfa" },
  { id: "staff-b", name: "Staff B", sprite: "employee-2", accent: "#38bdf8" },
  { id: "staff-c", name: "Staff C", sprite: "employee-3", accent: "#f472b6" },
] as const;

/** Which bodies read as women, so the picker and the floor can stay balanced. */
export const FEMALE_LOOKS = new Set(["backend", "frontend", "security", "staff-b"]);

const STORAGE_KEY = "yuppy.characters.v1";

export type CharacterMap = Record<string, string>;

function read(): CharacterMap {
  if (typeof window === "undefined") return {};
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    if (!parsed || typeof parsed !== "object") return {};
    const out: CharacterMap = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (typeof v === "string" && CHARACTERS.some((c) => c.id === v)) out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

function write(map: CharacterMap) {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
  } catch {
    // presentation only
  }
}

/**
 * Character assignments, shared by the office canvas and the picker panel.
 * Reads localStorage on mount only, so SSR output stays deterministic.
 */
export function useCharacters() {
  const [map, setMap] = useState<CharacterMap>({});
  useEffect(() => {
    queueMicrotask(() => setMap(read()));
  }, []);
  const assign = (agentId: string, characterId: string | null) => {
    setMap((prev) => {
      const next = { ...prev };
      if (characterId) next[agentId] = characterId;
      else delete next[agentId];
      write(next);
      return next;
    });
  };
  return { map, assign };
}

/** Resolve the look for an agent: explicit choice first, else a stable
 * deterministic pick derived from the id (so looks never collide randomly). */
export function characterFor(agentId: string, map?: CharacterMap): CharacterLook {
  const chosen = map?.[agentId];
  if (chosen) {
    const hit = CHARACTERS.find((c) => c.id === chosen);
    if (hit) return hit;
  }
  let h = 0;
  for (let i = 0; i < agentId.length; i++) h = (h * 31 + agentId.charCodeAt(i)) >>> 0;
  return CHARACTERS[h % CHARACTERS.length];
}

/**
 * The sprite body the office should draw for an agent.
 *
 * `seatKey` matters: without it every Claude Code seat resolves to the same
 * body, so a full floor looks like one person copied eight times. Pass the
 * seat key wherever one exists; identity-level callers (a chip with no seat)
 * omit it and get the CLI's signature body.
 */
export function spriteBaseFor(
  agentId: string,
  map?: CharacterMap,
  seatKey?: string,
  /** Pre-computed body for this seat (see `bodiesForSeats`). */
  assigned?: string,
): string {
  const chosen = map?.[agentId];
  if (chosen) {
    const hit = CHARACTERS.find((c) => c.id === chosen);
    if (hit) return hit.sprite;
  }
  if (assigned) return assigned;
  return charBaseFor(agentId, seatKey);
}

/** Accent colour for an agent's bubbles/chips, following the same pick. */
export function accentFor(agentId: string, map?: CharacterMap): string {
  const chosen = map?.[agentId];
  if (chosen) {
    const hit = CHARACTERS.find((c) => c.id === chosen);
    if (hit) return hit.accent;
  }
  const a = agentId.toLowerCase();
  if (a.includes("claude")) return "#e08a5c";
  if (a.includes("codex")) return "#7dd3a0";
  return "#8b9cf7";
}

/** True when `sprite` is one of the bodies we actually ship art for. */
export function isKnownSprite(sprite: string): boolean {
  return (CHAR_BASES as readonly string[]).includes(sprite);
}
