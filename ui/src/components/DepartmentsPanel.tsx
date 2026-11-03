"use client";

import { ChevronRight, Waypoints } from "lucide-react";
import { useHudStore } from "@/lib/store";

const thinScrollbar =
  "[scrollbar-width:thin] [scrollbar-color:var(--line-strong)_transparent] [&::-webkit-scrollbar]:w-1 [&::-webkit-scrollbar-track]:bg-transparent [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-[var(--line-strong)]";

/**
 * Department roster from the HUD store. Selecting a department scopes new
 * CLI sessions and tasks; roles show which CLI/model each seat is bound to.
 */
export default function DepartmentsPanel() {
  const departments = useHudStore((s) => s.departments);
  const selectedDept = useHudStore((s) => s.selectedDept);
  const setSelectedDept = useHudStore((s) => s.setSelectedDept);

  const enabledCount = departments.filter((d) => d.enabled).length;

  return (
    <section className="overflow-hidden rounded-md border border-[var(--line)] bg-[var(--panel)]">
      <header className="flex items-center justify-between gap-2 border-b border-[var(--line)] bg-[var(--bg-1)]/40 px-3 py-2">
        <div className="flex min-w-0 items-center gap-2">
          <Waypoints className="h-3 w-3 shrink-0 text-[var(--text-lo)]" aria-hidden />
          <span className="truncate text-[10px] font-semibold uppercase tracking-[0.2em] text-[var(--text-lo)]">
            Departments
          </span>
        </div>
        <span className="shrink-0 font-mono text-[10px] tabular-nums text-[var(--text-lo)]">
          {enabledCount}/{departments.length} on
        </span>
      </header>

      {departments.length === 0 ? (
        <div className="flex flex-col items-center gap-1.5 px-3 py-6 text-center">
          <Waypoints className="h-4 w-4 text-[var(--text-lo)]/60" aria-hidden />
          <p className="text-[11px] text-[var(--text-lo)]">No departments loaded.</p>
        </div>
      ) : (
        <ul className={`max-h-64 overflow-y-auto ${thinScrollbar}`}>
          {departments.map((d) => {
            const isSelected = selectedDept === d.id;
            const roleCount = d.roles?.length ?? 0;
            return (
              <li key={d.id} className="border-b border-[var(--line)]/50 last:border-b-0">
                <button
                  type="button"
                  onClick={() => setSelectedDept(d.id)}
                  aria-pressed={isSelected}
                  className={`group relative flex w-full items-center gap-2 py-2 pl-3 pr-3 text-left text-xs transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-[var(--accent)]/60 ${
                    isSelected
                      ? "bg-[var(--accent-dim)] text-[var(--text-hi)]"
                      : "text-[var(--text-mid)] hover:bg-[var(--bg-2)]/60 hover:text-[var(--text-hi)]"
                  }`}
                >
                  <span
                    className={`absolute inset-y-0 left-0 w-0.5 transition-opacity ${
                      isSelected ? "bg-[var(--accent)] opacity-100" : "bg-[var(--accent)] opacity-0"
                    }`}
                    aria-hidden
                  />
                  {d.icon ? (
                    <span className="w-4 shrink-0 text-center text-[13px] leading-none" aria-hidden>
                      {d.icon}
                    </span>
                  ) : null}
                  <span className={`min-w-0 flex-1 truncate ${d.enabled ? "" : "text-[var(--text-lo)]"}`}>
                    {d.name}
                  </span>
                  {roleCount > 0 && (
                    <span className="shrink-0 font-mono text-[10px] tabular-nums text-[var(--text-lo)]">
                      {roleCount}
                    </span>
                  )}
                  <span
                    className={`h-1.5 w-1.5 shrink-0 rounded-full transition-colors ${
                      d.enabled
                        ? isSelected
                          ? "bg-[var(--ok)]"
                          : "bg-[var(--ok)]/70"
                        : "bg-[var(--text-lo)]/50"
                    }`}
                    title={d.enabled ? "enabled" : "disabled"}
                    aria-label={d.enabled ? "enabled" : "disabled"}
                  />
                  <ChevronRight
                    className={`h-3 w-3 shrink-0 transition-transform duration-150 ${
                      isSelected ? "rotate-90 text-[var(--accent)]" : "text-[var(--text-lo)]/0 group-hover:text-[var(--text-lo)]/60"
                    }`}
                    aria-hidden
                  />
                </button>
                {isSelected && (
                  <ul className="border-t border-[var(--line)] bg-[var(--bg-1)]/50 px-3 py-1.5">
                    {roleCount === 0 ? (
                      <li className="py-1 text-[10px] italic text-[var(--text-lo)]">
                        No roles bound to this department.
                      </li>
                    ) : (
                      d.roles!.map((r) => (
                        <li
                          key={r.id}
                          className="flex items-baseline justify-between gap-2 py-0.5 text-[11px]"
                        >
                          <span className="min-w-0 truncate text-[var(--text-mid)]">{r.name}</span>
                          <span className="shrink-0 truncate font-mono text-[10px] text-[var(--text-lo)]" title={`${r.cli}${r.model ? ` · ${r.model}` : ""}`}>
                            {r.cli}
                            {r.model ? ` · ${r.model}` : ""}
                          </span>
                        </li>
                      ))
                    )}
                  </ul>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
