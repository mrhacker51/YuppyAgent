"use client";

import type { CSSProperties } from "react";
import {
  Bot,
  Clapperboard,
  Landmark,
  LayoutGrid,
  Radar,
  ShieldCheck,
  Sparkles,
} from "lucide-react";
import type { SquadIcon } from "@/lib/teamIdentity";

const ICONS = {
  grid: LayoutGrid,
  bot: Bot,
  shield: ShieldCheck,
  radar: Radar,
  clapper: Clapperboard,
  vault: Landmark,
  spark: Sparkles,
} as const;

/** The one place a squad callsign's icon is resolved, shared by the team
 * tabs and the lead panel so a team always wears the same glyph. */
export default function SquadGlyph({
  icon,
  size = 12,
  className,
  style,
}: {
  icon: SquadIcon;
  size?: number;
  className?: string;
  style?: CSSProperties;
}) {
  const Icon = ICONS[icon];
  return <Icon size={size} className={className} style={style} aria-hidden />;
}
