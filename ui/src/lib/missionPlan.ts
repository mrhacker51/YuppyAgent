/**
 * Lead-plan extraction + validation for the mission-dispatch flow.
 *
 * A live lead seat (the operator's own Claude terminal) is briefed to print
 * exactly one fenced block:
 *
 *   ```yuppy-plan
 *   {"goal":"...","slices":[{"cli":"claude-code","role":"backend","title":"t","prompt":"...","isolation":"worktree"}]}
 *   ```
 *
 * JSON under the fence may be wrapped by the terminal at any column (VT100
 * reflows are indistinguishable from tokens), so every newline inside the
 * fence is dropped before parsing — safe as long as no string contains an
 * escaped newline, which the brief forbids. Anything outside the fence is
 * ignored; a missing or malformed fence returns null, never a guess.
 */

export type PlannedCli = "claude-code" | "codex";

export interface MissionSlice {
  cli: PlannedCli;
  role: string;
  title: string;
  prompt: string;
  isolation: "worktree" | "shared";
  /**
   * The service/area this slice owns ("web", "desktop", "cli", "core",
   * "docs"…). One slice per service is what makes the fan-out parallel
   * instead of two agents editing the same files.
   */
  service?: string;
  /** The team (department id) that owns the slice, when the lead named one. */
  department?: string;
}

export interface MissionPlan {
  goal: string;
  slices: MissionSlice[];
}

export const MAX_PLAN_SLICES = 4;
const KNOWN_CLIS = new Set(["claude-code", "codex"]);

/** Balanced-brace scan starting at the first "{" — string- and escape-aware.
 * Returns the JSON substring, or null when the block is still streaming.
 * A closing fence is not needed: the JSON delimits itself. */
function balancedJson(s: string): string | null {
  const start = s.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return s.slice(start, i + 1);
    }
  }
  return null;
}

/**
 * Rebuild compact JSON from terminal-rendered text.
 *
 * Two corruptions come from the screen, not the lead:
 *  - hard wraps put a raw newline + indent *inside* string literals;
 *  - the block is indented, so whitespace sits between tokens.
 * Outside strings every whitespace is dropped (JSON does not need it). Inside
 * strings a raw control character is collapsed to a single space, so prose
 * keeps its word breaks instead of turning into "kısaad". Escaped sequences
 * pass through untouched.
 */
function compactJson(s: string): string {
  let out = "";
  let inStr = false;
  let esc = false;
  let pendingSpace = false;
  for (const ch of s) {
    if (inStr) {
      if (esc) {
        out += ch;
        esc = false;
        continue;
      }
      if (ch === "\\") {
        out += ch;
        esc = true;
        continue;
      }
      if (ch === '"') {
        inStr = false;
        out += ch;
        continue;
      }
      if (ch === "\n" || ch === "\r" || ch === "\t") {
        pendingSpace = true;
        continue;
      }
      if (pendingSpace) {
        if (ch === " ") continue; // indentation after the wrap
        if (out.length && out[out.length - 1] !== " " && ch !== " ") out += " ";
        pendingSpace = false;
      }
      out += ch;
      continue;
    }
    if (ch === '"') {
      inStr = true;
      out += ch;
      continue;
    }
    if (/\s/.test(ch)) continue;
    out += ch;
  }
  return out;
}

/**
 * Extract and validate the plan block from terminal text (a single screen or
 * a rolling transcript of snapshots). Returns the typed plan, or a rejection
 * with a human-readable reason — never throws, never guesses.
 *
 * The transcript also contains the *echo of the brief* — the template JSON the
 * operator's prompt carried, complete with `<placeholder>` fields. That echo
 * can never be a real plan, so those candidates are skipped; the scan walks
 * candidates newest-first and returns the first one that validates. Only when
 * a non-template candidate is closed and still unparseable does it report an
 * error (and the approval gate stays shut).
 */
export function extractMissionPlan(text: string): { plan: MissionPlan } | { error: string } | null {
  const starts: number[] = [];
  let at = text.indexOf("yuppy-plan");
  while (at !== -1) {
    starts.push(at);
    at = text.indexOf("yuppy-plan", at + 1);
  }
  if (starts.length === 0) return null;
  let sawClosed = false;
  let lastError: string | null = null;
  for (let i = starts.length - 1; i >= 0; i--) {
    const rawJson = balancedJson(text.slice(starts[i]));
    if (rawJson === null) continue; // still streaming / screen cut off
    if (/<[^<>\n]{2,80}>/.test(rawJson)) continue; // brief template echo
    sawClosed = true;
    try {
      const parsed: unknown = JSON.parse(compactJson(rawJson));
      const validated = validateMissionPlan(parsed);
      if ("plan" in validated) return validated;
      lastError = validated.error;
    } catch {
      lastError = "plan bloğundaki JSON çözülemedi";
    }
  }
  if (sawClosed && lastError) return { error: lastError };
  return null;
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function validateMissionPlan(parsed: unknown): { plan: MissionPlan } | { error: string } {
  if (typeof parsed !== "object" || parsed === null) return { error: "plan nesne değil" };
  const p = parsed as Record<string, unknown>;
  if (typeof p.goal !== "string" || p.goal.trim().length < 3) return { error: "goal eksik" };
  if (!Array.isArray(p.slices) || p.slices.length === 0) return { error: "slices boş" };
  if (p.slices.length > MAX_PLAN_SLICES)
    return { error: `en fazla ${MAX_PLAN_SLICES} dilim (${p.slices.length} geldi)` };
  const slices: MissionSlice[] = [];
  for (const [i, raw] of p.slices.entries()) {
    if (typeof raw !== "object" || raw === null) return { error: `dilim ${i + 1} nesne değil` };
    const s = raw as Record<string, unknown>;
    const cli = String(s.cli ?? "");
    if (!KNOWN_CLIS.has(cli)) return { error: `dilim ${i + 1}: bilinmeyen cli "${cli || "?"}" (claude-code|codex)` };
    if (typeof s.title !== "string" || s.title.trim().length < 2)
      return { error: `dilim ${i + 1}: title eksik` };
    if (typeof s.prompt !== "string" || s.prompt.trim().length < 4)
      return { error: `dilim ${i + 1}: prompt eksik` };
    const role = typeof s.role === "string" && s.role.trim() ? s.role.trim() : "software-development";
    const isolation = s.isolation === "shared" ? "shared" : "worktree";
    // `team` is accepted as an alias so an older lead still produces usable
    // service groups instead of a plan that silently collapses into one team.
    const service = stringField(s.service) ?? stringField(s.team);
    const department = stringField(s.department);
    slices.push({
      cli: cli as PlannedCli,
      role,
      title: s.title.trim(),
      prompt: s.prompt.trim(),
      isolation,
      ...(service ? { service } : {}),
      ...(department ? { department } : {}),
    });
  }
  return { plan: { goal: p.goal.trim(), slices } };
}

/** A team (department) the lead may name in a slice. */
export interface ConductorTeam {
  id: string;
  name: string;
  roles: string[];
}

/** A codebase area that one slice may own. */
export interface ConductorService {
  id: string;
  name: string;
  paths: string[];
}

export interface ConductorContext {
  teams?: readonly ConductorTeam[];
  services?: readonly ConductorService[];
}

const DEFAULT_SERVICES: ConductorService[] = [
  { id: "web", name: "Web UI", paths: ["ui/"] },
  { id: "desktop", name: "Desktop shell", paths: ["desktop/"] },
  { id: "cli", name: "CLI & bridge", paths: ["crates/yuppycode-cli/"] },
  { id: "core", name: "Çekirdek crate'ler", paths: ["crates/", "Cargo.toml"] },
  { id: "docs", name: "Dokümantasyon", paths: ["docs/", "README.md"] },
];

/**
 * The conductor brief typed into the lead seat. Every rule here exists to
 * make the printed plan machine-checkable (one fence, compact JSON, no
 * newlines inside strings, at most 4 slices) and to make the fan-out
 * parallel-safe: each slice owns a distinct service, so two agents never
 * edit the same area at the same time.
 *
 * The roster is injected from the live bridge: the lead must name a real
 * department and one of the actual services, not a remembered id.
 */
export function conductorBrief(ctx: ConductorContext = {}): string {
  const teams = ctx.teams ?? [];
  const services = ctx.services ?? DEFAULT_SERVICES;
  const teamLines =
    teams.length > 0
      ? teams
          .map(
            (t) =>
              `- ${t.id} (${t.name})${t.roles.length ? ` — roller: ${t.roles.join(", ")}` : ""}`,
          )
          .join("\n")
      : "- (canlı departman listesi henüz gelmedi; department alanını boş bırak)";
  const serviceLines = services
    .map((s) => `- ${s.id} (${s.name}) — ${s.paths.join(", ")}`)
    .join("\n");
  return `TAKIM GÖREVİ VERİYORUM. Dosya düzenleme, araç çalıştırma, araştırma yapma.
Sadece planı yaz. Planı şu formatta, başka hiçbir şey eklemeden yaz:

\`\`\`yuppy-plan
{"goal":"<tek cümle hedef>","slices":[{"cli":"claude-code|codex","role":"<takım rolü>","department":"<takım id>","service":"<hizmet id>","title":"<kısa ad>","prompt":"<kendi kendine yetebilen, bağımsız çalıştırılabilir görev metni>","isolation":"worktree"}]}
\`\`\`

Kurallar: en fazla 4 dilim; cli yalnızca claude-code veya codex; her dilim kendi başına çalışır;
her dilim FARKLI bir hizmete ait olmalı (aynı hizmete iki dilim verme); department alanı aşağıdaki
takımlardan biri olmalı; service alanı aşağıdaki hizmetlerden biri olmalı; JSON kompakt tek blok;
stringlerde \\n asla yok; dışına metin yazma. Dilimler worktree'lerde PARALEL çalışır: aynı dosyaya
dokunacak işleri aynı dilimde topla, farklı hizmetlere böl.

TAKIMLAR (department alanı):
${teamLines}

HİZMETLER (service alanı):
${serviceLines}

KURULU BECERİLER (ajanlar SKILL.md olarak görür; dilim promptuna uygun olanı yaz):
UI/UX: impeccable, ui-ux-pro-max, taste-skill, frontend-design, web-design-guidelines, design-system, ui-styling, brand, banner-design, slides
Piksel VFX: pixelfx, pixelfx-artist (canvas efektleri, palet, sprite sheet)
Ofis haritası: claude-office (oda/masa/karakter sprite'ları, 800×600 koordinat sistemi)
Frontend: react-best-practices, composition-patterns, gsap, lenis, theme-factory, brand-guidelines
Video: remotion-create/studio/render/captions/maps/multimedia/markup/saas
İş akışı: brainstorming, writing-plans, test-driven-development, systematic-debugging, verification-before-completion, requesting-code-review, using-git-worktrees, dispatching-parallel-agents
Araştırma/kod: agent-reach, graphify, find-skills
Güvenlik/test: security-audit, webapp-testing
Her dilimin promptuna "ilgili beceriyi yükle" diye değil, becerinin adını anarak yaz (örn: "impeccable ve ui-ux-pro-max becerilerini kullanarak ...").`;
}

/** Default brief (no live roster): used when departments have not loaded. */
export const LEAD_CONDUCTOR_BRIEF = conductorBrief();
