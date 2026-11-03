import type { DepartmentDto } from "./protocol";

export type CardAccent = "cyan" | "violet" | "orange" | "emerald";
export type CarouselCardKind = "department" | "agent-management" | "task-center" | "custom";

export interface CarouselCard {
  id: string;
  name: string;
  subtitle: string;
  /** SVG line-icon key resolved by CardIcon. */
  icon: string;
  /** Backend-provided glyph shown verbatim for custom departments. */
  glyph?: string;
  accent: CardAccent;
  kind: CarouselCardKind;
  department?: DepartmentDto;
}

const ORDER = [
  "software-development",
  "youtube-content",
  "research",
  "code-review-testing",
  "finance",
] as const;

const META: Record<
  string,
  { name: string; subtitle: string; icon: string; accent: CardAccent }
> = {
  "software-development": {
    name: "Yazılım Geliştirme",
    subtitle: "Software Development",
    icon: "code",
    accent: "cyan",
  },
  "youtube-content": {
    name: "YouTube Studio",
    subtitle: "YouTube content creation & management",
    icon: "youtube",
    accent: "orange",
  },
  research: {
    name: "Araştırma",
    subtitle: "Research",
    icon: "research",
    accent: "violet",
  },
  "code-review-testing": {
    name: "Code Review / Test",
    subtitle: "Code Review & Testing",
    icon: "review",
    accent: "cyan",
  },
  finance: {
    name: "Finans",
    subtitle: "Finance",
    icon: "finance",
    accent: "orange",
  },
  "agent-management": {
    name: "Agent Yönetimi",
    subtitle: "Agents, terminals & registry",
    icon: "agents",
    accent: "violet",
  },
  "task-center": {
    name: "Görev Merkezi",
    subtitle: "Task queue, state & activity",
    icon: "tasks",
    accent: "cyan",
  },
  custom: {
    name: "Özel Departmanlar",
    subtitle: "Custom Departments",
    icon: "custom",
    accent: "emerald",
  },
};

const ACCENTS: CardAccent[] = ["cyan", "violet", "orange", "emerald"];

function titleFromId(id: string): string {
  return id
    .split(/[-_]/)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function realCard(dept: DepartmentDto, accent: CardAccent): CarouselCard {
  const meta = META[dept.id];
  return {
    id: dept.id,
    name: meta?.name ?? dept.name,
    subtitle: meta?.subtitle ?? dept.description ?? titleFromId(dept.id),
    icon: meta?.icon ?? "default",
    glyph: meta ? undefined : dept.icon || undefined,
    accent,
    kind: dept.id === "custom" ? "custom" : "department",
    department: dept,
  };
}

export function buildCarouselCards(departments: DepartmentDto[]): CarouselCard[] {
  const byId = new Map(departments.map((d) => [d.id, d]));
  const cards: CarouselCard[] = [];
  const used = new Set<string>();

  ORDER.forEach((id, index) => {
    const dept = byId.get(id);
    if (!dept) return;
    used.add(id);
    cards.push(realCard(dept, META[id]?.accent ?? ACCENTS[index % ACCENTS.length]));
  });

  const extras = departments
    .filter((d) => !used.has(d.id) && d.id !== "custom")
    .sort((a, b) => a.name.localeCompare(b.name));
  extras.forEach((dept, index) => {
    used.add(dept.id);
    cards.push(realCard(dept, ACCENTS[(cards.length + index) % ACCENTS.length]));
  });

  for (const system of ["agent-management", "task-center"] as const) {
    if (used.has(system)) continue;
    const meta = META[system];
    cards.push({
      id: system,
      name: meta.name,
      subtitle: meta.subtitle,
      icon: meta.icon,
      accent: meta.accent,
      kind: system,
      department: byId.get(system),
    });
    used.add(system);
  }

  const custom = byId.get("custom");
  if (custom) {
    cards.push(realCard(custom, "emerald"));
  } else {
    const meta = META.custom;
    cards.push({
      id: "custom",
      name: meta.name,
      subtitle: meta.subtitle,
      icon: meta.icon,
      accent: "emerald",
      kind: "custom",
    });
  }

  return cards;
}
