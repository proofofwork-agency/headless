import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Box, render, Text, useApp, useInput, useStdout } from "ink";
import { connectOrStartDaemon } from "../daemon/connect";
import type { HeadlessDaemonClient } from "../daemon/client";
import { runReconnectLoop, subscribeControlRoom, TuiController } from "./controller";
import { ChromeHeader, Footer, Rule, StatusStrip, TabBar } from "./components";
import { HEADLESS_COPYRIGHT, HEADLESS_VERSION } from "../version";
import { buildHitZones, buildTabLayout, hitTest, nextView, parseMouseEvents, viewForDigit } from "./layout";
import {
  approvalRows,
  type EventFilter,
  fleetAgentRows,
  type GoalHistoryMode,
  goalRows,
  initialControlRoomState,
  pendingApprovals,
  type TuiControlRoomState,
} from "./model";
import type { TuiView } from "./theme";
import { MUTED, WARN } from "./theme";
import {
  ApprovalsView,
  approvalsListMeta,
  ConfigView,
  EventsView,
  eventRowCount,
  FleetView,
  fleetListMeta,
  GoalsView,
  goalsListMeta,
  HelpView,
  OverviewView,
} from "./views";

const MOUSE_ON = "\u001b[?1000h\u001b[?1006h";
const MOUSE_OFF = "\u001b[?1000l\u001b[?1006l";
const TERMINAL_RESTORE = `${MOUSE_OFF}\u001b[0m\u001b[?25h`;

export type RunTuiOptions = {
  projectRoot?: string;
  connect?: (projectRoot: string) => Promise<HeadlessDaemonClient>;
};

export type AppProps = Required<Pick<RunTuiOptions, "projectRoot">> & Pick<RunTuiOptions, "connect">;
type Selections = { fleet: number; goals: number; approvals: number };

export const App: React.FC<AppProps> = ({ projectRoot, connect = connectProjectDaemon }) => {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const { width, height } = useTerminalSize(stdout);
  const [state, setState] = useState(() => initialControlRoomState(projectRoot));
  const stateRef = useRef(state);
  const [view, setView] = useState<TuiView>("overview");
  const [selections, setSelections] = useState<Selections>({ fleet: 0, goals: 0, approvals: 0 });
  const [eventScroll, setEventScroll] = useState(0);
  const [eventFilter, setEventFilter] = useState<EventFilter>("all");
  const [eventsGrouped, setEventsGrouped] = useState(true);
  const [goalHistoryMode, setGoalHistoryMode] = useState<GoalHistoryMode>("recent");
  const controllerRef = useRef<TuiController | null>(null);

  const patchState = useCallback((patch: Partial<TuiControlRoomState>) => {
    setState((current) => ({ ...current, ...patch }));
  }, []);
  const setStatus = useCallback((status: string) => patchState({ status }), [patchState]);
  useEffect(() => { stateRef.current = state; }, [state]);

  useEffect(() => {
    const abort = new AbortController();
    let refreshTimer: ReturnType<typeof setInterval> | null = null;
    void runReconnectLoop({
      signal: abort.signal,
      connect: () => connect(projectRoot),
      failed: (error) => patchState({ connection: "reconnecting", status: `Observer reconnecting: ${messageOf(error)}` }),
      connected: async (client) => {
        const controller = new TuiController(client, {
          getState: () => stateRef.current,
          patchState,
          setStatus,
          exit,
        });
        controllerRef.current = controller;
        await controller.refresh();
        refreshTimer = setInterval(() => { void controller.refresh().catch(() => {}); }, 2_000);
        await subscribeControlRoom(client, { getState: () => stateRef.current, patchState }, abort.signal);
      },
    });
    return () => {
      abort.abort();
      if (refreshTimer) clearInterval(refreshTimer);
      controllerRef.current = null;
    };
  }, [connect, exit, patchState, projectRoot, setStatus]);

  useEffect(() => {
    if (!process.stdout.isTTY) return;
    process.stdout.write(MOUSE_ON);
    return () => { process.stdout.write(MOUSE_OFF); };
  }, []);

  const badges = useMemo(() => ({
    approvals: pendingApprovals(state).length,
    events: state.events.filter((event) => event.kind === "stderr" || event.kind === "completion" && event.result.status !== "succeeded").length,
  }), [state]);
  const tabs = useMemo(() => buildTabLayout(width, badges), [badges, width]);
  const selected = { fleet: selections.fleet, goals: selections.goals, approvals: selections.approvals };
  const list = view === "fleet"
    ? fleetListMeta(state, width, height, selected.fleet)
    : view === "goals"
      ? goalsListMeta(state, width, height, selected.goals)
      : view === "approvals"
        ? approvalsListMeta(state, width, height, selected.approvals)
        : null;
  const hitZones = useMemo(() => buildHitZones({ width, height, view, badges, list }), [badges, height, list, view, width]);

  useInput((input, key) => {
    const mouse = parseMouseEvents(input);
    if (mouse.length > 0) {
      for (const event of mouse) {
        if (event.kind === "wheel-up" || event.kind === "wheel-down") moveSelection(event.kind === "wheel-up" ? -1 : 1);
        else {
          const action = hitTest(event.x, event.y, hitZones);
          if (action?.kind === "view") setView(action.view);
          if (action?.kind === "row") setSelected(action.index);
        }
      }
      return;
    }
    if (input === "q" || key.escape && view === "overview") return exit();
    if (key.escape) return setView("overview");
    if (key.tab) return setView((current) => nextView(current, key.shift ? -1 : 1));
    const digit = viewForDigit(input);
    if (digit) return setView(digit);
    if (key.upArrow || input === "k") return moveSelection(-1);
    if (key.downArrow || input === "j") return moveSelection(1);
    if (input === "r") return void controllerRef.current?.refresh();
    if (view === "events") {
      if (input === "e") setEventFilter((current) => current === "errors" ? "all" : "errors");
      if (input === "a") setEventFilter((current) => current === "activity" ? "all" : "activity");
      if (input === "g") setEventsGrouped((current) => !current);
      if (key.pageUp) setEventScroll((value) => Math.min(eventRowCount(height), value + 10));
      if (key.pageDown) setEventScroll((value) => Math.max(0, value - 10));
    }
    if (view === "goals" && input === "h") setGoalHistoryMode((current) => current === "recent" ? "all" : current === "all" ? "grouped" : "recent");

    function moveSelection(delta: number) {
      if (view === "events") return setEventScroll((value) => Math.max(0, value + delta));
      const total = view === "fleet" ? fleetAgentRows(stateRef.current).length
        : view === "goals" ? goalRows({ ...stateRef.current, historyMode: goalHistoryMode }).length
          : view === "approvals" ? approvalRows(stateRef.current).length : 0;
      if (total === 0) return;
      if (view === "fleet" || view === "goals" || view === "approvals") {
        setSelections((current) => ({ ...current, [view]: clamp(current[view], total, delta) }));
      }
    }

    function setSelected(index: number) {
      if (view === "fleet" || view === "goals" || view === "approvals") {
        setSelections((current) => ({ ...current, [view]: index }));
      }
    }
  });

  if (width < MIN_WIDTH || height < MIN_HEIGHT) return <MinimumSizeView width={width} height={height} />;
  const footer = view === "events"
    ? { hints: [["↑↓", "scroll"], ["e", "errors"], ["a", "activity"], ["g", "group"], ["r", "refresh"], ["q", "quit"]] as Array<[string, string]> }
    : { hints: [["⇥", "views"], ["1-7", "jump"], ["↑↓", "select"], ["r", "refresh"], ["q", "quit"]] as Array<[string, string]> };
  const footerRight = width < 100 ? HEADLESS_COPYRIGHT : `v${HEADLESS_VERSION} · ${HEADLESS_COPYRIGHT}`;

  return <Box flexDirection="column" width={width} height={height}>
    <ChromeHeader state={state} width={width} />
    <Rule width={width} />
    <TabBar segments={tabs} active={view} width={width} />
    <Box flexDirection="column" flexGrow={1}>
      {view === "overview" ? <OverviewView state={state} width={width} height={height} /> : null}
      {view === "fleet" ? <FleetView state={state} width={width} height={height} selected={selected.fleet} /> : null}
      {view === "goals" ? <GoalsView state={state} width={width} height={height} selected={selected.goals} historyMode={goalHistoryMode} /> : null}
      {view === "approvals" ? <ApprovalsView state={state} width={width} height={height} selected={selected.approvals} /> : null}
      {view === "events" ? <EventsView state={state} width={width} height={height} scrollBack={eventScroll} filter={eventFilter} grouped={eventsGrouped} mode={state.logMode} /> : null}
      {view === "config" ? <ConfigView state={state} width={width} height={height} /> : null}
      {view === "help" ? <HelpView width={width} height={height} /> : null}
    </Box>
    <Rule width={width} />
    <StatusStrip state={state} working={state.connection !== "connected"} width={width} />
    <Footer hints={footer.hints} right={footerRight} width={width} />
  </Box>;
};

export function runTui(options: RunTuiOptions = {}) {
  const projectRoot = options.projectRoot ?? process.cwd();
  const restoreTerminal = () => { if (process.stdout.isTTY) process.stdout.write(TERMINAL_RESTORE); };
  process.once("uncaughtExceptionMonitor", restoreTerminal);
  process.once("exit", restoreTerminal);
  const instance = render(<App projectRoot={projectRoot} connect={options.connect} />, { exitOnCtrlC: true });
  const done = instance.waitUntilExit?.() ?? Promise.resolve();
  return done.finally(() => {
    process.off("uncaughtExceptionMonitor", restoreTerminal);
    process.off("exit", restoreTerminal);
    restoreTerminal();
  });
}

function connectProjectDaemon(projectRoot: string) {
  return connectOrStartDaemon({ projectRoot, credential: { observer: true }, bootstrapObserver: true });
}

function useTerminalSize(stdout: NodeJS.WriteStream) {
  const read = useCallback(() => ({ width: dimension(stdout.columns, 96), height: dimension(stdout.rows, 28) }), [stdout]);
  const [size, setSize] = useState(read);
  useEffect(() => {
    const resize = () => setSize(read());
    stdout.on("resize", resize);
    return () => { stdout.off("resize", resize); };
  }, [read, stdout]);
  return size;
}

export const MIN_WIDTH = 60;
export const MIN_HEIGHT = 20;

function dimension(value: number | undefined, fallback: number) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function MinimumSizeView({ width, height }: { width: number; height: number }) {
  return <Box flexDirection="column" width={width} height={height} paddingX={1}>
    <Text color={WARN}>Terminal too small for the observer.</Text>
    <Text color={MUTED}>Resize to at least {MIN_WIDTH}×{MIN_HEIGHT} (current {width}×{height}).</Text>
    <Text color={MUTED}>The daemon is still running; no work was cancelled.</Text>
  </Box>;
}

function clamp(current: number, total: number, delta: number) {
  return Math.max(0, Math.min(total - 1, current + delta));
}

function messageOf(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
