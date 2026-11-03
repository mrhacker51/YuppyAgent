"use client";

import {
  Brain,
  Code2,
  Cpu,
  FolderTree,
  GitBranch,
  HardDrive,
  Server,
  Sparkles,
  SquareTerminal,
  TriangleAlert,
} from "lucide-react";
import { useHudStore } from "@/lib/store";
import { Card, EmptyState, Stat, ViewShell, dispatchCommandTarget } from "./shared";
import { INSTALL_PATHS, SKILL_CATALOG, TOTAL_SKILLS } from "@/lib/skills";
import { teamIdentity } from "@/lib/teamIdentity";
import Badge from "../fancy/Badge";

function agentShortName(agent: string): string {
  if (agent.includes("claude")) return "Claude Code";
  if (agent.includes("codex")) return "Codex";
  return agent;
}

/**
 * Code module. There is no editor endpoint in bridge v2; this view shows the
 * real workspace and the worktree review events tasks emit.
 */
export function CodeView() {
  const engine = useHudStore((s) => s.engineInfo);
  const integrations = useHudStore((s) => s.integrations);
  const conflicts = useHudStore((s) => s.conflicts);
  const status = useHudStore((s) => s.status);

  return (
    <ViewShell
      title="Kod"
      kicker="workspace · worktree entegrasyonları"
      right={
        <span className="flex items-center gap-1.5 font-mono text-[8px] uppercase tracking-wider text-text-lo">
          <GitBranch size={9} className="text-accent" aria-hidden />
          {engine?.git_branch ?? "branch yok"}
        </span>
      }
      footer={
        <>
          <Code2 size={9} aria-hidden />
          <span>editör endpoint&apos;i yok · yalnızca gerçek worktree olayları gösterilir</span>
          <span className="ml-auto text-text-lo/70">
            {integrations.length} entegrasyon · {conflicts.length} çakışma
          </span>
        </>
      }
    >
      <div className="space-y-1 p-1">
        <Card title="Çalışma alanı" sub="bridge engine">
          {engine ? (
            <div className="grid gap-1 p-2 sm:grid-cols-2 xl:grid-cols-4">
              <div>
                <div className="font-mono text-[8px] uppercase tracking-wider text-text-lo">yol</div>
                <div className="mt-0.5 break-all font-mono text-[9px] text-text-mid">
                  {engine.workspace}
                </div>
              </div>
              <div>
                <div className="font-mono text-[8px] uppercase tracking-wider text-text-lo">branch</div>
                <div className="mt-0.5 font-mono text-[9px] text-text-mid">
                  {engine.git_branch ?? "git checkout değil"}
                </div>
              </div>
              <div>
                <div className="font-mono text-[8px] uppercase tracking-wider text-text-lo">provider</div>
                <div className="mt-0.5 font-mono text-[9px] text-text-mid">
                  {engine.provider} · {engine.model || "CLI modeli"}
                </div>
              </div>
              <div>
                <div className="font-mono text-[8px] uppercase tracking-wider text-text-lo">durum</div>
                <div className="mt-0.5 font-mono text-[9px] text-text-mid">{engine.engine_state}</div>
              </div>
            </div>
          ) : (
            <div className="p-2">
              <EmptyState>
                {status === "connected" ? "engine bilgisi bekleniyor…" : "bridge bağlı değil"}
              </EmptyState>
            </div>
          )}
        </Card>

        <div className="grid gap-1 xl:grid-cols-2">
          <Card title="Worktree entegrasyonları" sub={`${integrations.length} olay`}>
            {integrations.length === 0 ? (
              <div className="p-2">
                <EmptyState>henüz entegrasyon olayı yok</EmptyState>
              </div>
            ) : (
              <div className="divide-y divide-line/50">
                {integrations
                  .slice()
                  .reverse()
                  .map((entry, i) => (
                    <div key={`${entry.taskId}-${entry.ts}-${i}`} className="px-2 py-1.5">
                      <div className="flex items-center gap-1.5 font-mono text-[9px]">
                        <GitBranch size={9} className="text-accent" aria-hidden />
                        <span className="text-accent">{entry.branch}</span>
                        <span className="text-text-lo">task {entry.taskId.slice(-8)}</span>
                        <span
                          className={`ml-auto border px-1 py-px text-[8px] uppercase tracking-wider ${
                            entry.committed ? "border-ok/30 text-ok" : "border-warn/30 text-warn"
                          }`}
                        >
                          {entry.committed ? "commit" : "commit yok"}
                        </span>
                      </div>
                      <ul className="mt-1 space-y-px">
                        {entry.changedFiles.slice(0, 8).map((file) => (
                          <li key={file} className="truncate font-mono text-[8px] text-text-lo">
                            {file}
                          </li>
                        ))}
                        {entry.changedFiles.length === 0 && (
                          <li className="font-mono text-[8px] text-text-lo">
                            değişen dosya bildirilmedi
                          </li>
                        )}
                        {entry.changedFiles.length > 8 && (
                          <li className="font-mono text-[8px] text-text-lo">
                            +{entry.changedFiles.length - 8} dosya
                          </li>
                        )}
                      </ul>
                    </div>
                  ))}
              </div>
            )}
          </Card>

          <Card title="Çakışmalar" sub={`${conflicts.length} manuel merge`}>
            {conflicts.length === 0 ? (
              <div className="p-2">
                <EmptyState>çakışma yok</EmptyState>
              </div>
            ) : (
              <div className="divide-y divide-line/50">
                {conflicts
                  .slice()
                  .reverse()
                  .map((conflict, i) => (
                    <div key={`${conflict.path}-${conflict.ts}-${i}`} className="px-2 py-1.5">
                      <div className="flex items-center gap-1.5 font-mono text-[9px]">
                        <TriangleAlert size={9} className="text-danger" aria-hidden />
                        <span className="min-w-0 flex-1 truncate text-danger">{conflict.path}</span>
                      </div>
                      <div className="mt-0.5 font-mono text-[8px] text-text-lo">
                        {conflict.taskA} × {conflict.taskB}
                      </div>
                    </div>
                  ))}
              </div>
            )}
          </Card>
        </div>

        <div className="flex items-start gap-2 border border-line bg-bg-1/35 px-2 py-1.5 font-mono text-[8px] leading-relaxed text-text-lo">
          <TriangleAlert size={10} className="mt-0.5 shrink-0 text-warn/80" aria-hidden />
          <p>
            bridge v2 bir kod editörü veya dosya izleme API&apos;si sunmuyor. Bu görünümdeki
            branch ve dosya listeleri yalnızca tamamlanan izole görevlerin gerçek entegrasyon
            olaylarından gelir; editör taklidi yapılmaz.
          </p>
        </div>
      </div>
    </ViewShell>
  );
}

/** Files module: real workspace roots, no fake tree because v2 has no FS API. */
export function FilesView() {
  const engine = useHudStore((s) => s.engineInfo);
  const departments = useHudStore((s) => s.departments);
  const agents = useHudStore((s) => s.agents);
  const status = useHudStore((s) => s.status);
  const selectedDept = useHudStore((s) => s.selectedDept);
  const setSelectedDept = useHudStore((s) => s.setSelectedDept);
  const openTerminal = useHudStore((s) => s.openTerminal);
  const connected = status === "connected";
  const firstAgent = agents.find((a) => a.available);

  return (
    <ViewShell
      title="Dosyalar"
      kicker="çalışma alanı kökleri"
      right={
        <span className="flex items-center gap-1.5 font-mono text-[8px] uppercase tracking-wider text-text-lo">
          <FolderTree size={9} className="text-accent" aria-hidden />
          salt okunur
        </span>
      }
      footer={
        <>
          <TriangleAlert size={9} className="text-warn/80" aria-hidden />
          <span>bridge v2 dosya tarayıcı API&apos;si yok · dosyalara PTY içindeki CLI ile erişilir</span>
        </>
      }
    >
      <div className="space-y-1 p-1">
        <Card title="Engine çalışma alanı" sub="backend bildirimi">
          <div className="flex flex-wrap items-center gap-2 p-2">
            <HardDrive size={14} className="text-text-lo" aria-hidden />
            <span className="min-w-0 flex-1 break-all font-mono text-[10px] text-text-mid">
              {engine?.workspace ?? "—"}
            </span>
            <span className="border border-line px-1.5 py-0.5 font-mono text-[8px] uppercase tracking-wider text-text-lo">
              {engine?.git_branch ? `git: ${engine.git_branch}` : "git yok"}
            </span>
            <button
              type="button"
              disabled={!connected || !firstAgent}
              onClick={() =>
                firstAgent &&
                openTerminal(
                  firstAgent.id,
                  `${engine?.workspace ?? "workspace"} · shell`,
                  selectedDept || undefined,
                )
              }
              className="flex items-center gap-1 border border-accent/40 bg-accent-dim px-1.5 py-0.5 font-mono text-[8px] uppercase tracking-wider text-accent transition-colors hover:border-accent/70 disabled:cursor-not-allowed disabled:border-line disabled:bg-transparent disabled:text-text-lo focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/50"
            >
              <SquareTerminal size={8} aria-hidden /> terminal aç
            </button>
          </div>
        </Card>

        <Card title="Takım çalışma alanları" sub={`${departments.length} departman`}>
          {departments.length === 0 ? (
            <div className="p-2">
              <EmptyState>
                {status === "connected" ? "departman yok" : "bridge bağlı değil"}
              </EmptyState>
            </div>
          ) : (
            <div className="divide-y divide-line/50">
              {departments.map((dept) => (
                <div key={dept.id} className="flex flex-wrap items-center gap-2 px-2 py-1.5">
                  <span className="text-[11px]" aria-hidden>
                    {dept.icon || "▦"}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-[10px] text-text-mid">
                    {dept.name}
                  </span>
                  <span className="min-w-0 truncate font-mono text-[8px] text-text-lo">
                    {dept.workspace || "engine workspace miras alınır"}
                  </span>
                  <button
                    type="button"
                    onClick={() => setSelectedDept(dept.id)}
                    className="border border-transparent px-1 py-0.5 font-mono text-[8px] uppercase tracking-wider text-text-lo transition-colors hover:border-line hover:text-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/50"
                  >
                    hedef
                  </button>
                  <button
                    type="button"
                    disabled={!connected || !firstAgent}
                    onClick={() =>
                      firstAgent &&
                      openTerminal(
                        firstAgent.id,
                        `${dept.name} · shell`,
                        dept.id,
                      )
                    }
                    className="flex items-center gap-1 border border-line px-1.5 py-0.5 font-mono text-[8px] uppercase tracking-wider text-text-mid transition-colors hover:border-line-strong hover:text-accent disabled:cursor-not-allowed disabled:border-line/60 disabled:text-text-lo/60 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/50"
                  >
                    <SquareTerminal size={8} aria-hidden /> shell
                  </button>
                </div>
              ))}
            </div>
          )}
        </Card>

        <div className="flex items-start gap-2 border border-line bg-bg-1/35 px-2 py-1.5 font-mono text-[8px] leading-relaxed text-text-lo">
          <TriangleAlert size={10} className="mt-0.5 shrink-0 text-warn/80" aria-hidden />
          <p>
            Dosya ağacı, önizleme ve düzenleme bridge v2&apos;de yok. Bu yüzden burada sahte
            bir dosya listesi yerine gerçek çalışma alanı kökleri ve o köke bağlanan terminal
            eylemleri gösterilir.
          </p>
        </div>
      </div>
    </ViewShell>
  );
}

/** Memory module: read-only engine/MCP facts. */
export function MemoryView() {
  const engine = useHudStore((s) => s.engineInfo);
  const status = useHudStore((s) => s.status);

  return (
    <ViewShell
      title="Hafıza"
      kicker="engine bellek ve MCP durumu"
      right={
        <span
          className={`border px-1.5 py-0.5 font-mono text-[8px] uppercase tracking-wider ${
            engine?.memory_enabled ? "border-ok/30 text-ok" : "border-line text-text-lo"
          }`}
        >
          {engine ? (engine.memory_enabled ? "memory açık" : "memory kapalı") : "bilinmiyor"}
        </span>
      }
      footer={
        <>
          <Brain size={9} aria-hidden />
          <span>salt okunur · bridge v2 memory CRUD endpoint&apos;i yok</span>
        </>
      }
    >
      <div className="space-y-1 p-1">
        <div className="grid gap-1 xl:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
          <Card title="Motor" sub="provider rotası">
            {engine ? (
              <div className="divide-y divide-line/50 font-mono text-[9px]">
                <div className="flex items-center justify-between px-2 py-1.5">
                  <span className="text-text-lo">provider</span>
                  <span className="text-text-mid">{engine.provider}</span>
                </div>
                <div className="flex items-center justify-between px-2 py-1.5">
                  <span className="text-text-lo">model</span>
                  <span className="text-text-mid">{engine.model || "CLI varsayılanı"}</span>
                </div>
                <div className="flex items-center justify-between px-2 py-1.5">
                  <span className="text-text-lo">engine state</span>
                  <span className="text-text-mid">{engine.engine_state}</span>
                </div>
                <div className="flex items-center justify-between px-2 py-1.5">
                  <span className="text-text-lo">memory</span>
                  <span className={engine.memory_enabled ? "text-ok" : "text-text-lo"}>
                    {engine.memory_enabled ? "etkin" : "devre dışı"}
                  </span>
                </div>
              </div>
            ) : (
              <div className="p-2">
                <EmptyState>
                  {status === "connected" ? "engine bilgisi bekleniyor…" : "bridge bağlı değil"}
                </EmptyState>
              </div>
            )}
          </Card>

          <Card title="MCP sunucuları" sub={`${engine?.mcp_servers.length ?? 0} kayıtlı`}>
            {engine && engine.mcp_servers.length > 0 ? (
              <ul className="divide-y divide-line/50">
                {engine.mcp_servers.map((server) => (
                  <li
                    key={server}
                    className="flex items-center gap-1.5 px-2 py-1.5 font-mono text-[9px] text-text-mid"
                  >
                    <Server size={9} className="text-accent/70" aria-hidden />
                    <span className="truncate">{server}</span>
                    <span className="ml-auto border border-ok/25 px-1 py-px font-mono text-[8px] uppercase tracking-wider text-ok">
                      bağlı
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <div className="p-2">
                <EmptyState>kayıtlı MCP sunucusu yok</EmptyState>
              </div>
            )}
          </Card>
        </div>

        <div className="flex items-start gap-2 border border-line bg-bg-1/35 px-2 py-1.5 font-mono text-[8px] leading-relaxed text-text-lo">
          <Brain size={10} className="mt-0.5 shrink-0 text-accent/70" aria-hidden />
          <p>
            Hafıza durumu ve MCP listesi bridge engine bilgisinden okunur. Bellek kaydı
            oluşturma, düzenleme veya silme bu sürümde yok; ajanlar hafızalarını kendi CLI
            süreçleri içinde yönetir.
          </p>
        </div>
      </div>
    </ViewShell>
  );
}

/** Skills module: department role config + tool policy + detected CLI versions. */
export function SkillsView() {
  const departments = useHudStore((s) => s.departments);
  const agents = useHudStore((s) => s.agents);
  const status = useHudStore((s) => s.status);
  const verifySkills = useHudStore((s) => s.verifySkills);
  const setSelectedDept = useHudStore((s) => s.setSelectedDept);
  const selectedDept = useHudStore((s) => s.selectedDept);

  const rows = departments.flatMap((dept) =>
    (dept.roles ?? []).map((role) => ({ dept, role })),
  );

  return (
    <ViewShell
      title="Beceriler"
      kicker="roller · model eşlemesi · tool politikası"
      right={
        <span className="flex items-center gap-1.5 font-mono text-[8px] uppercase tracking-wider text-text-lo">
          <Sparkles size={9} className="text-accent" aria-hidden />
          {rows.length} rol · {agents.length} CLI
        </span>
      }
      footer={
        <>
          <Sparkles size={9} aria-hidden />
          <span>beceri editörü yok · roller departman konfigürasyonundan gelir</span>
          <span className="ml-auto text-text-lo/70">bridge v2 salt okunur</span>
        </>
      }
    >
      <div className="grid grid-cols-2 gap-1 p-1 pb-0 sm:grid-cols-4">
        <Stat label="takım" value={departments.length} tone="accent" hint="canlı departman kaydı" />
        <Stat label="rol" value={rows.length} hint="takım → CLI eşlemesi" />
        <Stat
          label="hazır CLI"
          value={`${agents.filter((a) => a.available).length}/${agents.length}`}
          tone={agents.some((a) => !a.available) ? "warn" : "ok"}
          hint="PATH taraması"
        />
        <Stat
          label="beceri paketi"
          value={SKILL_CATALOG.length}
          hint={`${TOTAL_SKILLS} SKILL.md`}
        />
      </div>

      <div className="grid gap-1 p-1 xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <Card title="Rol matrisi" sub="takım → rol → CLI">
          {rows.length === 0 ? (
            <div className="p-2">
              <EmptyState>tanımlı rol yok</EmptyState>
            </div>
          ) : (
            <div>
              <div className="grid grid-cols-[minmax(0,1fr)_110px_120px_70px] gap-2 border-b border-line bg-bg-0/40 px-2 py-1.5 font-mono text-[8px] uppercase tracking-[0.14em] text-text-lo">
                <span>rol / takım</span>
                <span>CLI</span>
                <span>model</span>
                <span className="text-right">hedef</span>
              </div>
              {rows.map(({ dept, role }) => (
                <div
                  key={`${dept.id}-${role.id}`}
                  className={`grid grid-cols-[minmax(0,1fr)_110px_120px_70px] items-center gap-2 border-b border-line/50 px-2 py-1.5 transition-colors hover:bg-bg-2/40 ${
                    selectedDept === dept.id ? "bg-accent/[0.03]" : ""
                  }`}
                >
                  <div className="min-w-0">
                    <div className="flex items-center gap-1.5">
                      <span className="truncate text-[10.5px] text-text-mid">{role.name}</span>
                      {role.enabled === false && (
                        <Badge tone="danger" size="sm">pasif</Badge>
                      )}
                    </div>
                    <div className="mt-0.5 flex items-center gap-1 truncate font-mono text-[8px] text-text-lo">
                      <span
                        className="shrink-0 font-semibold uppercase tracking-[0.12em]"
                        style={{ color: teamIdentity(dept.id, dept.name).accent }}
                      >
                        {teamIdentity(dept.id, dept.name).callsign}
                      </span>
                      <span className="text-line">·</span>
                      <span className="truncate">
                        {dept.name}
                        {role.description ? ` — ${role.description}` : ""}
                      </span>
                    </div>
                  </div>
                  <span className="truncate font-mono text-[8px] text-text-mid">
                    {agentShortName(role.cli)}
                  </span>
                  <span className="truncate font-mono text-[8px] text-text-lo">
                    {role.model || "CLI varsayılanı"}
                  </span>
                  <div className="flex justify-end">
                    <button
                      type="button"
                      onClick={() => {
                        setSelectedDept(dept.id);
                        dispatchCommandTarget(role.cli, dept.id);
                      }}
                      className="border border-line px-1.5 py-0.5 font-mono text-[8px] uppercase tracking-wider text-text-mid transition-colors hover:border-line-strong hover:text-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/50"
                    >
                      hedef
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </Card>

        <div className="space-y-1">
          <Card
            title="Kurulu ajan becerileri"
            sub={`${SKILL_CATALOG.length} paket · ${TOTAL_SKILLS} SKILL.md`}
          >
            <div className="divide-y divide-line/50">
              {SKILL_CATALOG.map((pack) => {
                return (
                <div key={pack.id} className="px-2 py-1.5">
                  <div className="flex items-center gap-1.5">
                    <Sparkles size={9} className="shrink-0 text-accent/80" aria-hidden />
                    <span className="min-w-0 flex-1 truncate font-mono text-[9.5px] text-text-mid">
                      {pack.name}
                    </span>
                    <span
                      title="bu liste kurulum manifestosudur — canlı doğrulama için aşağıdaki düğmeyle ajanın kendi ls çıktısını gör"
                      className="shrink-0 border border-line/70 px-1 py-px font-mono text-[7px] uppercase tracking-wider text-text-lo"
                    >
                      manifesto
                    </span>
                    {pack.skills.length > 1 && (
                      <span className="shrink-0 tabular-nums text-[7.5px] text-text-lo/70">
                        ×{pack.skills.length}
                      </span>
                    )}
                    {pack.agents.map((agent) => (
                      <span
                        key={agent}
                        title={`${pack.name} → ${agentShortName(agent)}`}
                        className="shrink-0 border border-accent/25 bg-accent/[0.06] px-1 py-px font-mono text-[7px] uppercase tracking-wider text-accent/80"
                      >
                        {agent === "codex" ? "cx" : "cc"}
                      </span>
                    ))}
                    {pack.tags.slice(0, 2).map((tag) => (
                      <span
                        key={tag}
                        className="shrink-0 border border-line/70 px-1 py-px font-mono text-[7.5px] uppercase tracking-wider text-text-lo"
                      >
                        {tag}
                      </span>
                    ))}
                  </div>
                  <p className="mt-0.5 pl-[15px] text-[8.5px] leading-[1.5] text-text-lo">
                    {pack.description}
                  </p>
                  <p className="mt-0.5 flex items-center gap-1 pl-[15px] font-mono text-[7.5px] text-text-lo/60">
                    <span className="truncate">
                      {pack.source} · {pack.skills.length === 1 ? pack.skills[0] : `${pack.skills[0]} +${pack.skills.length - 1}`}
                    </span>
                    <a
                      href={pack.repo}
                      target="_blank"
                      rel="noreferrer noopener"
                      className="ml-auto shrink-0 text-text-lo/70 underline decoration-line underline-offset-2 hover:text-accent"
                    >
                      repo
                    </a>
                  </p>
                </div>
                );
              })}
            </div>
            <div className="flex flex-wrap items-center gap-1 border-t border-line/50 px-2 py-1.5">
              <span className="font-mono text-[7.5px] uppercase tracking-wider text-text-lo">
                konumlar
              </span>
              <span className="font-mono text-[7.5px] text-text-lo/80">
                {INSTALL_PATHS.claude} · {INSTALL_PATHS.codex} · {INSTALL_PATHS.codexLegacy}
              </span>
              <button
                type="button"
                onClick={verifySkills}
                disabled={status !== "connected"}
                title="Gerçek Claude koltuğuna ls komutu yazar; ajanın kendi Bash çıktısını terminalde görürsün — hiçbir şey uydurulmaz"
                className="ml-auto border border-line px-1.5 py-0.5 font-mono text-[8px] uppercase tracking-wider text-text-mid transition-colors hover:border-line-strong hover:text-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/50 disabled:cursor-not-allowed disabled:text-text-lo/50"
              >
                ajan listelesin
              </button>
            </div>
          </Card>

          <Card title="Yürütücü sürümleri" sub="PATH taraması">
            <div className="divide-y divide-line/50">
              {agents.map((agent) => (
                <div key={agent.id} className="px-2 py-1.5">
                  <div className="flex items-center gap-1.5">
                    <Cpu size={9} className={agent.available ? "text-accent/80" : "text-danger/70"} aria-hidden />
                    <span className="min-w-0 flex-1 truncate text-[10px] text-text-mid">
                      {agentShortName(agent.id)}
                    </span>
                    <span
                      className={`border px-1 py-px font-mono text-[8px] uppercase tracking-wider ${
                        agent.available
                          ? "border-ok/25 text-ok"
                          : "border-danger/30 text-danger"
                      }`}
                    >
                      {agent.available ? "hazır" : "yok"}
                    </span>
                  </div>
                  <div className="mt-0.5 flex items-center gap-1.5 font-mono text-[8px] text-text-lo">
                    <span className="truncate">{agent.version ?? "sürüm bilinmiyor"}</span>
                    <span className="ml-auto truncate text-text-lo/60">{agent.id}</span>
                  </div>
                  {!agent.available && agent.install_hint && (
                    <p className="mt-1 font-mono text-[8px] text-danger/80">{agent.install_hint}</p>
                  )}
                </div>
              ))}
              {agents.length === 0 && (
                <p className="px-2 py-3 font-mono text-[9px] text-text-lo">CLI envanteri yok.</p>
              )}
            </div>
          </Card>

          <Card title="Tool politikası" sub="departman allow-list">
            <div className="space-y-1 px-2 py-1.5">
              {departments.map((dept) => (
                <div key={dept.id} className="font-mono text-[8px]">
                  <div className="flex items-center gap-1 text-text-mid">
                    <span aria-hidden>{dept.icon}</span>
                    <span className="truncate">{dept.name}</span>
                    <span className="ml-auto text-text-lo">{dept.allowed_tools?.length ?? 0}</span>
                  </div>
                  <div className="mt-0.5 flex flex-wrap gap-1">
                    {(dept.allowed_tools ?? []).map((tool) => (
                      <span key={tool} className="border border-line/70 px-1 py-px text-text-lo">
                        {tool}
                      </span>
                    ))}
                    {(dept.allowed_tools ?? []).length === 0 && (
                      <span className="text-text-lo/60">kısıt bildirilmedi</span>
                    )}
                  </div>
                </div>
              ))}
              {departments.length === 0 && (
                <p className="font-mono text-[8px] text-text-lo">departman yok</p>
              )}
            </div>
          </Card>
        </div>
      </div>
    </ViewShell>
  );
}
