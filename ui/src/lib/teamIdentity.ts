/**
 * Team identities — the callsign, icon and accent a department wears in the
 * chrome.
 *
 * The backend owns departments (id, name, roles); this module only decorates
 * them. A callsign is presentation, never a second source of truth: the real
 * department name always stays visible in the tab's second line and in its
 * tooltip, so "OPTIMUS" can never be mistaken for a team the bridge does not
 * actually have. The mapping is pure and stable, which is what keeps a team's
 * colour and icon from changing between renders or reloads.
 */

export type SquadIcon =
  | "grid"
  | "bot"
  | "shield"
  | "radar"
  | "clapper"
  | "vault"
  | "spark";

export interface Squad {
  /** Department id; "" is the whole-deck tab. */
  id: string;
  /** Short callsign shown on the tab. */
  callsign: string;
  /** Real department name, exactly as the bridge reported it. */
  name: string;
  /** Short functional label under the callsign. */
  role: string;
  icon: SquadIcon;
  accent: string;
}

interface SquadStyle {
  callsign: string;
  role: string;
  icon: SquadIcon;
  accent: string;
}

/**
 * Known departments get a fixed callsign. Patterns are checked against both
 * the id and the display name, because a bridge may rename a department
 * without changing its id (or vice versa).
 */
const KNOWN: ReadonlyArray<SquadStyle & { match: RegExp }> = [
  {
    match: /software|yazılım|engineering|dev\b|geliştirme/i,
    callsign: "OPTIMUS",
    role: "Yazılım",
    icon: "bot",
    accent: "#5eead4",
  },
  {
    match: /review|test|qa\b|kalite|code review/i,
    callsign: "MEGATRON",
    role: "Review",
    icon: "shield",
    accent: "#8b9cf7",
  },
  {
    match: /research|araştırma|analiz|analysis/i,
    callsign: "SOUNDWAVE",
    role: "Araştırma",
    icon: "radar",
    accent: "#fbbf24",
  },
  {
    match: /youtube|content|içerik|media|video|yayın/i,
    callsign: "BUMBLEBEE",
    role: "İçerik",
    icon: "clapper",
    accent: "#fb7185",
  },
  {
    match: /finans|finance|account|muhasebe|bütçe/i,
    callsign: "VAULT",
    role: "Finans",
    icon: "vault",
    accent: "#4ade80",
  },
  {
    match: /custom|özel|general|genel/i,
    callsign: "RONIN",
    role: "Özel",
    icon: "spark",
    accent: "#a78bfa",
  },
];

/** Unknown departments draw from this pool, indexed by position so two
 * custom teams never share a callsign by accident. */
const FALLBACK: readonly SquadStyle[] = [
  { callsign: "ATLAS", role: "Takım", icon: "spark", accent: "#38bdf8" },
  { callsign: "COMET", role: "Takım", icon: "radar", accent: "#f472b6" },
  { callsign: "VECTOR", role: "Takım", icon: "bot", accent: "#22d3ee" },
  { callsign: "ECHO", role: "Takım", icon: "grid", accent: "#facc15" },
  { callsign: "ORION", role: "Takım", icon: "shield", accent: "#c084fc" },
  { callsign: "NOVA", role: "Takım", icon: "clapper", accent: "#fb923c" },
];

export const ALL_SQUAD: Squad = {
  id: "",
  callsign: "TÜMÜ",
  name: "Bütün ekipler",
  role: "toplam",
  icon: "grid",
  accent: "#9db0c6",
};

/**
 * Identity for one department. `index` is the department's position in the
 * live registry; it only breaks ties between unknown departments.
 */
export function teamIdentity(id: string, name: string, index = 0): Squad {
  const real = name.trim() || id;
  const key = `${id} ${real}`;
  const known = KNOWN.find((k) => k.match.test(key));
  if (known) {
    return {
      id,
      callsign: known.callsign,
      name: real,
      role: known.role,
      icon: known.icon,
      accent: known.accent,
    };
  }
  const fallback = FALLBACK[index % FALLBACK.length];
  return {
    id,
    callsign: fallback.callsign,
    name: real,
    role: fallback.role,
    icon: fallback.icon,
    accent: fallback.accent,
  };
}

/** Build the tab list: the whole-deck tab first, then every department. */
export function squadList(
  departments: ReadonlyArray<{ id: string; name: string }>,
): Squad[] {
  return [ALL_SQUAD, ...departments.map((d, i) => teamIdentity(d.id, d.name, i))];
}
