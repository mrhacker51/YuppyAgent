/**
 * Ajan becerileri (Agent Skills) kataloğu.
 *
 * Bunlar bu makinede gerçekten kurulu olan SKILL.md paketleridir. Her satır bir
 * *paket*tir (birden çok SKILL.md içerebilir); `skills` alanı kurulan klasör
 * adlarını listeler. Kurulum yolları `INSTALL_PATHS` içinde. UI yalnızca bu
 * listeyi gösterir, uydurma "aktif beceri" üretmez. Doğrulama gerçek bir
 * koltukta `ls` çalıştırarak yapılır (VERIFY_COMMAND).
 */

export interface SkillPack {
  /** paket kimliği (UI anahtarı) */
  id: string;
  name: string;
  /** ne yapar + ne zaman tetiklenir */
  description: string;
  source: string;
  /** GitHub deposu */
  repo: string;
  /** hangi ajanlar kullanır */
  agents: readonly ("claude-code" | "codex")[];
  tags: readonly string[];
  /** kurulan skill klasörleri (ilk satırda gösterilir) */
  skills: readonly string[];
}

const BOTH = ["claude-code", "codex"] as const;

export const SKILL_CATALOG: readonly SkillPack[] = [
  // ---------------------------------------------------------------- meta
  {
    id: "find-skills",
    name: "find-skills",
    description:
      "Ajanın ihtiyaç duyduğu beceriyi skills.sh kataloğunda arar ve npx skills ile kurar. \"bunun için bir skill var mı?\" sorusunun cevabı.",
    source: "vercel-labs/skills",
    repo: "https://github.com/vercel-labs/skills",
    agents: BOTH,
    tags: ["meta", "keşif"],
    skills: ["find-skills"],
  },
  {
    id: "superpowers",
    name: "superpowers",
    description:
      "Disiplinli geliştirme akışı: brainstorm → plan → TDD → alt-ajanlarla yürütme → kod incelemesi → doğrulama. Ajanın kendi işini denetlemesini sağlar.",
    source: "obra/superpowers",
    repo: "https://github.com/obra/superpowers",
    agents: BOTH,
    tags: ["iş akışı", "TDD", "inceleme"],
    skills: [
      "using-superpowers",
      "brainstorming",
      "writing-plans",
      "executing-plans",
      "test-driven-development",
      "systematic-debugging",
      "verification-before-completion",
      "requesting-code-review",
      "receiving-code-review",
      "subagent-driven-development",
      "dispatching-parallel-agents",
      "using-git-worktrees",
      "finishing-a-development-branch",
      "writing-skills",
      "diagnosing-superpowers",
    ],
  },
  {
    id: "agent-reach",
    name: "agent-reach",
    description:
      "小红书, B站, X, Reddit, YouTube, GitHub, V2EX, 雪球, LinkedIn gibi platformlardan salt-okunur içerik/arama/transkript çeker. Yazma işlemi yapmaz.",
    source: "Panniantong/agent-reach",
    repo: "https://github.com/Panniantong/agent-reach",
    agents: BOTH,
    tags: ["araştırma", "web"],
    skills: ["agent-reach"],
  },
  {
    id: "graphify",
    name: "graphify",
    description:
      "Kod tabanını kalıcı bir bilgi grafiğine çevirir; mimari, dosya ilişkileri ve 'nerede tanımlı' sorularını grafik üzerinden yanıtlar.",
    source: "Graphify-Labs/graphify",
    repo: "https://github.com/Graphify-Labs/graphify",
    agents: BOTH,
    tags: ["kod", "grafik"],
    skills: ["graphify"],
  },

  // ------------------------------------------------------------------ UI/UX
  {
    id: "impeccable",
    name: "impeccable",
    description:
      "Ön yüzü tasarla/eleştir/cilala: hiyerarşi, tipografi, renk, hareket, UX metni, erişilebilirlik, responsive, kenar durumlar, DESIGN.md ve token çıkarımı.",
    source: "pbakaus/impeccable",
    repo: "https://github.com/pbakaus/impeccable",
    agents: BOTH,
    tags: ["UI", "UX", "denetim"],
    skills: ["impeccable"],
  },
  {
    id: "ui-ux-pro-max",
    name: "ui-ux-pro-max",
    description:
      "Aranabilir yerel tasarım verisi: 79 stil, 192 ürün paleti, 74 font eşleşmesi, 119 UX kuralı, 105 ikon, 25 grafik tipi, 22 stack. Sayfa/bileşen/design system üretir.",
    source: "nextlevelbuilder/ui-ux-pro-max-skill",
    repo: "https://github.com/nextlevelbuilder/ui-ux-pro-max-skill",
    agents: BOTH,
    tags: ["UI", "UX", "design system"],
    skills: ["ui-ux-pro-max"],
  },
  {
    id: "ui-ux-suite",
    name: "ui-ux suite",
    description:
      "ui-ux-pro-max'in alt paketleri: ui-styling (shadcn/Tailwind), design, design-system (token katmanları), brand, banner-design, slides (Chart.js sunum).",
    source: "nextlevelbuilder/ui-ux-pro-max-skill",
    repo: "https://github.com/nextlevelbuilder/ui-ux-pro-max-skill",
    agents: BOTH,
    tags: ["UI", "tasarım", "sunum"],
    skills: ["ui-styling", "design", "design-system", "brand", "banner-design", "slides"],
  },
  {
    id: "taste-skill",
    name: "taste-skill",
    description:
      "\"AI işi\" görünen arayüzü gerçekten tasarlanmış hissettirir: 247 galeri sitesinden damıtılmış sanat yönü, gerçek tarayıcı denetçisi, bak-düzelt döngüsü.",
    source: "leonxlnx/taste-skill",
    repo: "https://github.com/leonxlnx/taste-skill",
    agents: BOTH,
    tags: ["UI", "sanat yönü"],
    skills: ["taste-skill"],
  },
  {
    id: "frontend-design",
    name: "frontend-design",
    description:
      "Yeni UI kurarken veya mevcut arayüzü yeniden şekillendirirken özgün görsel yön, tipografi ve şablon-dışı estetik kararlar.",
    source: "anthropics/skills",
    repo: "https://github.com/anthropics/skills",
    agents: BOTH,
    tags: ["UI", "tasarım"],
    skills: ["frontend-design"],
  },
  {
    id: "web-design-guidelines",
    name: "web-design-guidelines",
    description:
      "Arayüz kodunu Web Interface Guidelines'a göre denetler: erişilebilirlik, etkileşim, tipografi, UX tutarlılığı.",
    source: "vercel-labs/agent-skills",
    repo: "https://github.com/vercel-labs/agent-skills",
    agents: BOTH,
    tags: ["UI", "denetim", "a11y"],
    skills: ["web-design-guidelines"],
  },
  {
    id: "theme-brand",
    name: "tema · marka",
    description:
      "theme-factory 10 hazır tema uygular/üretir; brand-guidelines marka renk ve tipografisini bir artefakta tutarlı uygular.",
    source: "anthropics/skills",
    repo: "https://github.com/anthropics/skills",
    agents: BOTH,
    tags: ["tasarım", "tema", "marka"],
    skills: ["theme-factory", "brand-guidelines"],
  },

  // ------------------------------------------------------------- frontend
  {
    id: "react-best-practices",
    name: "vercel-react-best-practices",
    description:
      "React/Next.js performans kuralları (40+ kural, 8 kategori): waterfall'lar, bundle boyutu, veri çekme, render maliyeti.",
    source: "vercel-labs/agent-skills",
    repo: "https://github.com/vercel-labs/agent-skills",
    agents: BOTH,
    tags: ["React", "performans"],
    skills: ["react-best-practices"],
  },
  {
    id: "composition-patterns",
    name: "vercel-composition-patterns",
    description:
      "Ölçeklenen React kompozisyon desenleri: boolean prop çoğalması yerine compound component, context, render props.",
    source: "vercel-labs/agent-skills",
    repo: "https://github.com/vercel-labs/agent-skills",
    agents: BOTH,
    tags: ["React", "mimari"],
    skills: ["composition-patterns"],
  },
  {
    id: "gsap",
    name: "GSAP",
    description:
      "Web animasyonu: tween, timeline, ScrollTrigger, Flip, Draggable, SplitText, MotionPath, @gsap/react entegrasyonu ve performans ayarı.",
    source: "greensock/gsap",
    repo: "https://github.com/greensock/gsap",
    agents: BOTH,
    tags: ["animasyon", "frontend"],
    skills: ["gsap"],
  },
  {
    id: "lenis",
    name: "Lenis",
    description:
      "Yumuşak kaydırma: vanilla/React/Vue/Nuxt kurulumu, GSAP ScrollTrigger senkronu, scroll snap, yatay/iç içe kaydırma, sticky sorunları.",
    source: "darkroomengineering/lenis",
    repo: "https://github.com/darkroomengineering/lenis",
    agents: BOTH,
    tags: ["kaydırma", "frontend"],
    skills: ["lenis"],
  },
  {
    id: "webapp-testing",
    name: "webapp-testing",
    description:
      "Playwright ile yerel web uygulamasını gerçek tarayıcıda test eder: akış doğrulama, ekran görüntüsü, konsol logları.",
    source: "anthropics/skills",
    repo: "https://github.com/anthropics/skills",
    agents: BOTH,
    tags: ["test", "tarayıcı"],
    skills: ["webapp-testing"],
  },

  // ---------------------------------------------------------------- video
  {
    id: "remotion",
    name: "Remotion (13)",
    description:
      "Kod ile video: create/studio/render/captions/maps/multimedia/interactivity/markup/saas/docs/upgrade/license/best-practices — React bileşenleriyle video üretimi.",
    source: "remotion-dev/remotion",
    repo: "https://github.com/remotion-dev/remotion",
    agents: BOTH,
    tags: ["video", "React"],
    skills: [
      "remotion-create",
      "remotion-studio",
      "remotion-render",
      "remotion-captions",
      "remotion-maps",
      "remotion-multimedia",
      "remotion-interactivity",
      "remotion-markup",
      "remotion-saas",
      "remotion-docs",
      "remotion-upgrade",
      "remotion-license",
      "remotion-best-practices",
    ],
  },

  // ------------------------------------------------------------- office art
  {
    id: "claude-office",
    name: "claude-office",
    description:
      "İzometrik ofis referansı: MIT lisanslı oda/masa/karakter sprite'ları ve 800×600 oda koordinat modeli. Ofis haritası, mobilya yerleşimi ve karakter gövdeleri buradan gelir (fan-art skin hariç).",
    source: "W17ant/Claude-Office",
    repo: "https://github.com/W17ant/Claude-Office",
    agents: BOTH,
    tags: ["ofis", "sprite", "izometrik", "pixel art"],
    skills: ["claude-office"],
  },

  // ------------------------------------------------------------- pixel vfx
  {
    id: "pixelfx",
    name: "pixelfx",
    description:
      "244 kod tabanlı pixel-art efekti (ateş, hava, buz, yıldırım, sci-fi, UI, geçişler) + draft→render→bak→düzelt döngüsü. YuppyCode ofis gökyüzü, görev konfetisi ve terminal CRT yüzeyleri bununla çalışır.",
    source: "patch-gg/pixelfx",
    repo: "https://github.com/patch-gg/pixelfx",
    agents: BOTH,
    tags: ["pixel art", "VFX", "canvas", "ofis"],
    skills: ["pixelfx", "pixelfx-artist"],
  },

  // ------------------------------------------------------------- security
  {
    id: "security-audit",
    name: "security-audit",
    description:
      "Kod tabanı, API, servis, CLI ve daemon için güvenlik incelemesi: tehdit modeli, zafiyet taraması, odaklı review, rapor üretimi.",
    source: "cloudflare/security-audit-skill",
    repo: "https://github.com/cloudflare/security-audit-skill",
    agents: BOTH,
    tags: ["güvenlik", "denetim"],
    skills: ["security-audit"],
  },
] as const;

export const INSTALL_PATHS = {
  claude: "~/.claude/skills",
  codexLegacy: "~/.codex/skills",
  codex: "~/.agents/skills",
  project: ".claude/skills · .agents/skills",
} as const;

/** Toplam kurulu skill klasörü sayısı (paketler açıldığında). */
export const TOTAL_SKILLS = SKILL_CATALOG.reduce((n, p) => n + p.skills.length, 0);

/**
 * The command the operator can send to a seat (button in Beceriler). We never
 * parse the answer — the honest signal is whatever the agent prints itself.
 */
export const VERIFY_COMMAND =
  "Sana kurulu Agent Skills'i listelemeni istiyorum. Yalnızca `ls -1 ~/.claude/skills ~/.agents/skills ~/.codex/skills 2>/dev/null | sort -u` çıktısını ver, başka hiçbir şey yazma.";

/** Per-agent skill hints, so the mission brief can tell the lead what exists. */
export const AGENT_SKILL_HINT = `Kurulu beceriler: ${TOTAL_SKILLS} SKILL.md (~/.claude/skills, ~/.agents/skills, ~/.codex/skills).`;
