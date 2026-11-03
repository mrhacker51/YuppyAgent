"use client";

import { useEffect, useRef, useState } from "react";
import { MotionConfig, AnimatePresence, motion } from "framer-motion";
import { TriangleAlert } from "lucide-react";
import { useHudStore } from "@/lib/store";
import {
  COMMAND_DEFAULT_SHARE,
  COMMAND_MAX_SHARE,
  COMMAND_MIN_SHARE,
  DECK_DEFAULT_SPLIT,
  DECK_MAX_SHARE,
  DECK_MIN_SHARE,
  OFFICE_DEFAULT_SHARE,
  OFFICE_MAX_SHARE,
  OFFICE_MIN_SHARE,
  clampShare,
  loadCommandSplit,
  loadDeckSplit,
  loadOfficeSplit,
  persistCommandSplit,
  persistDeckSplit,
  persistOfficeSplit,
} from "@/lib/panelResize";
import type { ModuleId } from "@/lib/modules";
import { useMounted } from "@/lib/useMounted";
import useKeyboardShortcuts from "@/lib/useKeyboardShortcuts";
import ShortcutHelp from "./ShortcutHelp";
import { MODULES } from "@/lib/modules";
import AppHeader from "./AppHeader";
import SplitSash from "./SplitSash";
import MissionConsole from "./MissionConsole";
import IsoOffice from "./office/IsoOffice";
import TerminalMatrix from "./TerminalMatrix";
import LeadTerminal from "./LeadTerminal";
import TeamCards from "./TeamCards";
import { dispatchCommandTarget } from "./views/shared";
import { MissionConfetti } from "./MissionConfetti";
import { TaskCompleteBanner } from "./TaskCompleteBanner";
import TeamView from "./views/TeamView";
import TasksView from "./views/TasksView";
import BrowserView from "./views/BrowserView";
import ReportsView from "./views/ReportsView";
import SettingsView from "./views/SettingsView";
import { CodeView, FilesView, MemoryView, SkillsView } from "./views/InfoViews";
import DeckBackground from "./fancy/DeckBackground";

/**
 * AgentSpace shell: app chrome + ten modules. The header carries the team
 * tabs; the right column is the selected team's lead (the main command
 * window, a real Claude Code CLI) over its agents' cards; the left column is
 * the office over the read-only information console and its running-work
 * list. The Tauri shell owns the bridge
 * connection in desktop builds; a browser uses the pairing form in Settings.
 * No panel is populated with mock agents or simulated terminal output.
 */
export default function AppShell() {
  const connect = useHudStore((s) => s.connect);
  const hydratePreferences = useHudStore((s) => s.hydratePreferences);
  const bridgeError = useHudStore((s) => s.bridgeError);
  const status = useHudStore((s) => s.status);
  const sessions = useHudStore((s) => s.sessions);
  const tasks = useHudStore((s) => s.tasks);
  const gitBranch = useHudStore((s) => s.engineInfo?.git_branch);
  const mounted = useMounted();
  const [activeModule, setActiveModule] = useState<ModuleId>("agentspace");
  const [helpOpen, setHelpOpen] = useState(false);
  // AgentSpace split — the operator drags the sash between the console column
  // and the terminal matrix. A percentage, so the deck still reflows when the
  // window (or the Tauri window) changes size.
  const [deckSplit, setDeckSplit] = useState(DECK_DEFAULT_SPLIT);
  const deckRef = useRef<HTMLDivElement>(null);
  const deckSplitRef = useRef(deckSplit);
  // Inside the left column: the office map against the mission console. The
  // operator drags the seam so a tall CLI or a tall office can win.
  const [officeSplit, setOfficeSplit] = useState(OFFICE_DEFAULT_SHARE);
  const officeRef = useRef<HTMLDivElement>(null);
  const officeSplitRef = useRef(officeSplit);
  // Right column: the lead Claude command window against the worker matrix.
  const [commandSplit, setCommandSplit] = useState(COMMAND_DEFAULT_SHARE);
  const commandRef = useRef<HTMLDivElement>(null);
  const commandSplitRef = useRef(commandSplit);

  useEffect(() => {
    deckSplitRef.current = deckSplit;
  }, [deckSplit]);
  useEffect(() => {
    officeSplitRef.current = officeSplit;
  }, [officeSplit]);
  useEffect(() => {
    commandSplitRef.current = commandSplit;
  }, [commandSplit]);

  const dragCommand = (deltaPx: number) => {
    const fallback = typeof window !== "undefined" ? window.innerHeight : 800;
    const height = Math.max(200, commandRef.current?.clientHeight ?? fallback);
    setCommandSplit((share) =>
      clampShare(share + (deltaPx / height) * 100, COMMAND_MIN_SHARE, COMMAND_MAX_SHARE),
    );
  };
  const resetCommand = () => {
    setCommandSplit(COMMAND_DEFAULT_SHARE);
    persistCommandSplit(COMMAND_DEFAULT_SHARE);
  };

  const dragDeck = (deltaPx: number) => {
    const fallback = typeof window !== "undefined" ? window.innerWidth : 1200;
    const width = Math.max(240, deckRef.current?.clientWidth ?? fallback);
    setDeckSplit((share) => clampShare(share + (deltaPx / width) * 100));
  };
  const resetDeck = () => {
    setDeckSplit(DECK_DEFAULT_SPLIT);
    persistDeckSplit(DECK_DEFAULT_SPLIT);
  };

  const dragOffice = (deltaPx: number) => {
    const fallback = typeof window !== "undefined" ? window.innerHeight : 800;
    const height = Math.max(200, officeRef.current?.clientHeight ?? fallback);
    setOfficeSplit((share) =>
      clampShare(share + (deltaPx / height) * 100, OFFICE_MIN_SHARE, OFFICE_MAX_SHARE),
    );
  };
  const resetOffice = () => {
    setOfficeSplit(OFFICE_DEFAULT_SHARE);
    persistOfficeSplit(OFFICE_DEFAULT_SHARE);
  };

  useEffect(() => {
    // Persisted presentation is applied after hydration so the exported HTML
    // and the first client render are identical.
    hydratePreferences();
    queueMicrotask(() => {
      setDeckSplit(loadDeckSplit());
      setOfficeSplit(loadOfficeSplit());
      setCommandSplit(loadCommandSplit());
    });
    // In Tauri the store bootstrap dials the sidecar with the shell-provided
    // port + token. Direct window check avoids a first-render race with
    // useMounted (which would otherwise try the browser default :9090).
    if (typeof window !== "undefined" && "__TAURI_INTERNALS__" in window) return;
    connect();
  }, [connect, hydratePreferences]);

  useEffect(() => {
    // Every launcher of the main command lands in AgentSpace, where the lead
    // Claude terminal lives (LeadTerminal focuses itself on arrival).
    const onTarget = () => setActiveModule("agentspace");
    window.addEventListener("yuppy:command-target", onTarget);
    return () => window.removeEventListener("yuppy:command-target", onTarget);
  }, []);

  // ⌘K lands in AgentSpace and focuses the lead Claude terminal. The target
  // is parked, so a LeadTerminal that mounts after the module switch still
  // takes focus.
  const focusPrompt = () => {
    setActiveModule("agentspace");
    dispatchCommandTarget(undefined, undefined);
  };

  useKeyboardShortcuts({
    modules: MODULES.map((m) => m.id),
    onModule: setActiveModule,
    onFocusPrompt: focusPrompt,
    onToggleHelp: () => setHelpOpen((v) => !v),
  });

  const desktopShell =
    mounted && typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
  const pendingDecisions = Object.values(tasks).filter(
    (t) => t.state === "awaiting_approval",
  ).length;

  return (
    /* One rule for every Framer animation in the deck: if the OS asks for
       reduced motion, transitions collapse to opacity-only. */
    <MotionConfig reducedMotion="user">
      <div className="relative h-dvh overflow-hidden text-text-hi">
        {/* Atmosphere sits at z-0, the deck at z-10. */}
        <DeckBackground />
        <div className="deck-shell-enter relative z-10 flex h-full min-h-0 flex-col gap-2 overflow-hidden p-2">
          <AppHeader active={activeModule} onSelect={setActiveModule} />

      {bridgeError && (
        <div className="flex shrink-0 items-center gap-1.5 rounded-[6px] border border-danger/25 bg-danger/[0.055] px-2 py-1 font-mono text-[9px] text-danger">
          <TriangleAlert size={9} className="shrink-0" aria-hidden />
          <span className="min-w-0 flex-1 truncate" title={bridgeError}>
            {bridgeError}
          </span>
          <button
            type="button"
            onClick={() => setActiveModule("settings")}
            className="shrink-0 border border-danger/30 px-1.5 py-px font-mono text-[8px] uppercase tracking-wider text-danger transition-colors hover:border-danger/60 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-danger/50"
          >
            ayarlar
          </button>
        </div>
      )}

      <main className="min-h-0 flex-1 overflow-hidden">
        <AnimatePresence mode="wait" initial={false}>
          <motion.div
            key={activeModule}
            initial={{ opacity: 0, y: 7, filter: "blur(2px)" }}
            animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
            exit={{ opacity: 0, y: -5, filter: "blur(2px)" }}
            transition={{ duration: 0.2, ease: [0.2, 0.8, 0.2, 1] }}
            className="h-full min-h-0"
          >
            {activeModule === "agentspace" ? (
              <div className="thin-scroll flex h-full min-h-0 flex-col gap-2 overflow-x-hidden overflow-y-auto xl:flex-row xl:overflow-y-hidden">
                {/* left: office map over the read-only information console,
                    split by a horizontal seam the operator can drag */}
                <div
                  ref={officeRef}
                  className="flex min-h-[580px] min-w-0 flex-col xl:h-auto xl:min-h-0"
                  style={{ flex: `${deckSplit} 1 0px` }}
                >
                  <div
                    className="flex min-h-[300px] flex-col xl:min-h-0"
                    style={{ flex: `${officeSplit} 1 0px` }}
                  >
                    <IsoOffice />
                  </div>

                  <SplitSash
                    orientation="horizontal"
                    label="Ofis ile konsol arasındaki yükseklik"
                    valueNow={officeSplit}
                    valueMin={OFFICE_MIN_SHARE}
                    valueMax={OFFICE_MAX_SHARE}
                    onDelta={dragOffice}
                    onCommit={() => persistOfficeSplit(officeSplitRef.current)}
                    onReset={resetOffice}
                    className="hidden h-[8px] w-full xl:block"
                  />

                  <div
                    className="flex min-h-[268px] flex-col xl:min-h-0"
                    style={{ flex: `${100 - officeSplit} 1 0px` }}
                  >
                    <MissionConsole />
                  </div>
                </div>

                <SplitSash
                  orientation="vertical"
                  label="Konsol ile ana ajan arasındaki bölüntü"
                  valueNow={deckSplit}
                  valueMin={DECK_MIN_SHARE}
                  valueMax={DECK_MAX_SHARE}
                  onDelta={dragDeck}
                  onCommit={() => persistDeckSplit(deckSplitRef.current)}
                  onReset={resetDeck}
                  className="hidden w-[8px] xl:block"
                />

                {/* right: TERMINALS — the selected team's lead (the large,
                    interactive Claude Code command window) over the compact
                    cards of its agents. Workers run headless; their cards
                    stream lines and open a PTY only on request. */}
                <div
                  ref={commandRef}
                  className="flex min-w-0 flex-col xl:h-auto xl:min-h-0"
                  style={{ flex: `${100 - deckSplit} 1 0px` }}
                >
                  <div
                    className="flex min-h-[420px] min-w-0 flex-col xl:min-h-0"
                    style={{ flex: `${commandSplit} 1 0px` }}
                  >
                    <LeadTerminal />
                  </div>

                  <SplitSash
                    orientation="horizontal"
                    label="Ana komut penceresi ile ekip matrisi arasındaki yükseklik"
                    valueNow={commandSplit}
                    valueMin={COMMAND_MIN_SHARE}
                    valueMax={COMMAND_MAX_SHARE}
                    onDelta={dragCommand}
                    onCommit={() => persistCommandSplit(commandSplitRef.current)}
                    onReset={resetCommand}
                    className="hidden h-[8px] w-full xl:block"
                  />

                  <div
                    className="mt-2 flex min-h-[360px] min-w-0 flex-col xl:mt-0 xl:min-h-0"
                    style={{ flex: `${100 - commandSplit} 1 0px` }}
                  >
                    <TeamCards />
                  </div>
                </div>
              </div>
            ) : activeModule === "terminals" ? (
              <div className="h-full min-h-0">
                <TerminalMatrix full />
              </div>
            ) : activeModule === "browser" ? (
              <div className="h-full min-h-0">
                <BrowserView />
              </div>
            ) : (
              <div className="h-full min-h-0">
                {activeModule === "team" && <TeamView />}
                {activeModule === "tasks" && <TasksView />}
                {activeModule === "code" && <CodeView />}
                {activeModule === "files" && <FilesView />}
                {activeModule === "memory" && <MemoryView />}
                {activeModule === "skills" && <SkillsView />}
                {activeModule === "reports" && <ReportsView />}
                {activeModule === "settings" && <SettingsView />}
              </div>
            )}
          </motion.div>
        </AnimatePresence>
      </main>

      {/* 24px status rail: real bridge facts only, never a decorative meter. */}
      <footer
        aria-label="Deck durumu"
        className="flex h-6 shrink-0 items-center gap-3 overflow-hidden rounded-[6px] border border-line/60 bg-surface-2/50 px-2.5 font-mono text-[8px] uppercase tracking-[0.14em] text-text-lo backdrop-blur-[2px]"
      >
        <span className="flex shrink-0 items-center gap-1.5">
          <span
            className={`size-1 rounded-full ${
              status === "connected" ? "status-pulse bg-ok" : "bg-text-lo"
            }`}
            aria-hidden
          />
          <span className={status === "connected" ? "text-ok" : "text-text-mid"}>
            {status === "connected" ? "köprü bağlı" : `köprü ${status}`}
          </span>
        </span>
        <span className="shrink-0 whitespace-nowrap">
          oturum <span className="tabular-nums text-text-mid">{sessions.length}</span>
        </span>
        <span className="shrink-0 whitespace-nowrap">
          görev <span className="tabular-nums text-text-mid">{Object.keys(tasks).length}</span>
        </span>
        {pendingDecisions > 0 && (
          <span className="shrink-0 whitespace-nowrap text-warn">
            {pendingDecisions} onay bekliyor
          </span>
        )}
        {gitBranch && (
          <span className="hidden min-w-0 truncate normal-case tracking-normal text-text-lo md:inline">
            {gitBranch}
          </span>
        )}
        <span className="ml-auto hidden shrink-0 whitespace-nowrap text-text-lo/80 sm:inline">
          ⌘K lead · ? kısayollar
        </span>
      </footer>

      <MissionConfetti />
      <TaskCompleteBanner />
      {helpOpen && <ShortcutHelp onClose={() => setHelpOpen(false)} />}
      <span className="sr-only" aria-live="polite">
        {desktopShell ? "Masaüstü shell bağlantısı" : "Tarayıcı bridge bağlantısı"}
      </span>
      </div>
      </div>
    </MotionConfig>
  );
}
