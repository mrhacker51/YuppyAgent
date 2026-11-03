import type { LucideIcon } from "lucide-react";
import {
  Brain,
  Code2,
  FileBarChart,
  FolderTree,
  Globe,
  LayoutDashboard,
  ListChecks,
  Settings,
  Sparkles,
  SquareTerminal,
  Users,
} from "lucide-react";

/**
 * The ten top-level modules from the AgentSpace brief. Every module has a
 * real view; modules the bridge does not expose say so explicitly instead of
 * rendering fake data.
 */
export type ModuleId =
  | "agentspace"
  | "team"
  | "tasks"
  | "terminals"
  | "browser"
  | "code"
  | "files"
  | "memory"
  | "skills"
  | "reports"
  | "settings";

export interface ModuleDef {
  id: ModuleId;
  label: string;
  icon: LucideIcon;
}

export const MODULES: readonly ModuleDef[] = [
  { id: "agentspace", label: "AgentSpace", icon: LayoutDashboard },
  { id: "team", label: "Takım", icon: Users },
  { id: "tasks", label: "Görevler", icon: ListChecks },
  { id: "terminals", label: "Terminaller", icon: SquareTerminal },
  { id: "browser", label: "Tarayıcı", icon: Globe },
  { id: "code", label: "Kod", icon: Code2 },
  { id: "files", label: "Dosyalar", icon: FolderTree },
  { id: "memory", label: "Hafıza", icon: Brain },
  { id: "skills", label: "Beceriler", icon: Sparkles },
  { id: "reports", label: "Raporlar", icon: FileBarChart },
  { id: "settings", label: "Ayarlar", icon: Settings },
] as const;

export function moduleLabel(id: ModuleId): string {
  return MODULES.find((m) => m.id === id)?.label ?? id;
}
