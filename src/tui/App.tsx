import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Box, render, Text, useApp, useInput, useStdout, type Key } from "ink";
import { connectOrStartDaemon } from "../daemon/connect";
import type { HeadlessDaemonClient } from "../daemon/client";
import { runReconnectLoop, subscribeControlRoom, TuiController } from "./controller";
import { ChromeHeader, Footer, PromptBar, StatusStrip, TabBar } from "./components";
import {
  buildHitZones,
  buildTabLayout,
  contentRows,
  hitTest,
  nextView,
  parseMouseEvents,
  viewForDigit,
  type HitZones,
} from "./layout";
import {
  approvalRows,
  fleetAgentRows,
  goalRows,
  initialControlRoomState,
  pendingApprovals,
  type TuiControlRoomState,
} from "./model";
import type { TuiView } from "./theme";
import {
  ApprovalsView,
  approvalsListMeta,
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
  const [view, setView] = useState<TuiView>("overview");
  const [input, setInput] = useState("");
  const [selections, setSelections] = useState<Selections>({ fleet: 0, goals: 0, approvals: 0 });
  const [eventScroll, setEventScroll] = useState(0);
  const [working, setWorking] = useState(false);
  const stateRef = useRef(state);
  const controllerRef = useRef<TuiController | null>(null);

  const patchState = useCallback((patch: Partial<TuiControlRoomState>) => {
    setState((current) => {
      const next = { ...current, ...patch };
      stateRef.current = next;
      return next;
    });
  }, []);
  const setStatus = useCallback((status: string) => {
    setWorking(status.endsWith("…"));
    patchState({ status });
  }, [patchState]);

  useEffect(() => {
    if (!process.stdout.isTTY) return;
    process.stdout.write(MOUSE_ON);
    return () => {
      process.stdout.write(MOUSE_OFF);
    };
  }, []);

  useEffect(() => {
    let stopped = false;

    const connectLoop = async () => {
      await runReconnectLoop({
        connect: () => connect(projectRoot),
        shouldStop: () => stopped,
        onConnecting: () => patchState({ connection: stateRef.current.projectId ? "reconnecting" : "connecting" }),
        onRetry: (error) => {
          controllerRef.current = null;
          patchState({ connection: "reconnecting" });
          setStatus(`Daemon connection lost: ${errorMessage(error)} · retrying…`);
        },
        consume: async (client) => {
          if (stopped) return;
          const controller = new TuiController(client, {
            getState: () => stateRef.current,
            patchState,
            setStatus,
            exit,
          });
          controllerRef.current = controller;
          await controller.refresh();
          if (stopped) return;
          patchState({ connection: "connected" });
          setStatus("Connected · free text goes to the active goal coordinator.");
          await subscribeControlRoom(
            client,
            { getState: () => stateRef.current, patchState },
            () => stopped,
            () => controller.refresh(),
          );
        },
      });
    };

    void connectLoop();
    return () => {
      stopped = true;
      controllerRef.current = null;
    };
  }, [connect, exit, patchState, projectRoot, setStatus]);

  const counts = useMemo(() => ({
    fleet: fleetAgentRows(state).length,
    goals: goalRows(state).length,
    approvals: approvalRows(state).length,
  }), [state]);
  const selected = useMemo<Selections>(() => ({
    fleet: clampIndex(selections.fleet, counts.fleet),
    goals: clampIndex(selections.goals, counts.goals),
    approvals: clampIndex(selections.approvals, counts.approvals),
  }), [counts, selections]);

  const badges = useMemo(() => ({
    approvals: pendingApprovals(state).length,
    goals: goalRows(state).filter((goal) => goal.active).length,
  }), [state]);
  const tabSegments = useMemo(() => buildTabLayout(width, badges), [badges, width]);

  const hitZones = useMemo<HitZones>(() => buildHitZones({
    width,
    height,
    view,
    badges,
    list: view === "fleet"
      ? fleetListMeta(state, width, height, selected.fleet)
      : view === "goals"
        ? goalsListMeta(state, width, height, selected.goals)
        : view === "approvals"
          ? approvalsListMeta(state, width, height, selected.approvals)
          : null,
  }), [badges, height, selected, state, view, width]);

  const maxEventScroll = Math.max(0, state.events.length - eventRowCount(height));
  const scrollEvents = useCallback((delta: number) => {
    setEventScroll((current) => Math.max(0, Math.min(maxEventScroll, current + delta)));
  }, [maxEventScroll]);

  const moveSelection = useCallback((delta: number) => {
    setSelections((current) => {
      if (view === "fleet") return { ...current, fleet: clampIndex(current.fleet + delta, counts.fleet) };
      if (view === "goals") return { ...current, goals: clampIndex(current.goals + delta, counts.goals) };
      if (view === "approvals") return { ...current, approvals: clampIndex(current.approvals + delta, counts.approvals) };
      return current;
    });
  }, [counts, view]);

  const activateRow = useCallback((rowView: TuiView, index: number) => {
    const controller = controllerRef.current;
    if (rowView === "fleet") {
      const agent = fleetAgentRows(stateRef.current)[index];
      if (agent) setSelections((current) => ({ ...current, fleet: index }));
      return;
    }
    if (rowView === "goals") {
      const goal = goalRows(stateRef.current)[index];
      if (!goal) return;
      setSelections((current) => ({ ...current, goals: index }));
      if (!goal.active && controller) controller.execute(`/use-goal ${goal.id}`);
      return;
    }
    if (rowView === "approvals") {
      const approval = approvalRows(stateRef.current)[index];
      if (!approval) return;
      setSelections((current) => ({ ...current, approvals: index }));
      setInput(`/approve ${approval.id} `);
    }
  }, []);

  const submit = useCallback(() => {
    const command = input.trim();
    setInput("");
    if (!command) {
      if (view === "fleet" || view === "goals" || view === "approvals") {
        activateRow(view, selected[view as keyof Selections]);
      }
      return;
    }
    const lower = command.toLowerCase();
    if (lower === "/help" || lower === "?") {
      setView("help");
      return;
    }
    if (lower === "/quit" || lower === "q") {
      exit();
      return;
    }
    const controller = controllerRef.current;
    if (controller) controller.execute(command);
    else setStatus("Daemon is reconnecting; input stays editable until the connection returns.");
  }, [activateRow, exit, input, selected, setStatus, view]);

  useInput((inputChar: string, key: Key) => {
    const mouseEvents = parseMouseEvents(inputChar);
    if (mouseEvents.length > 0) {
      for (const mouse of mouseEvents) {
        if (mouse.kind === "press") {
          const hit = hitTest(mouse.x, mouse.y, hitZones);
          if (hit?.kind === "view") {
            setView(hit.view);
          } else if (hit?.kind === "row") {
            if (view === "fleet") setSelections((current) => ({ ...current, fleet: hit.index }));
            else if (view === "goals") setSelections((current) => ({ ...current, goals: hit.index }));
            else if (view === "approvals") setSelections((current) => ({ ...current, approvals: hit.index }));
          }
          continue;
        }
        const delta = mouse.kind === "wheel-up" ? 1 : -1;
        if (view === "events") scrollEvents(delta * 3);
        else if (view === "fleet" || view === "goals" || view === "approvals") moveSelection(-delta);
      }
      return;
    }

    if (key.ctrl && inputChar.toLowerCase() === "c") {
      exit();
      return;
    }
    const isReturn = key.return || inputChar === "\r" || inputChar === "\n";
    if (isReturn) {
      submit();
      return;
    }
    if (key.escape) {
      if (input) {
        setInput("");
        return;
      }
      if (view === "events" && eventScroll > 0) {
        setEventScroll(0);
        return;
      }
      if (view !== "overview") {
        setView("overview");
        return;
      }
      setStatus("Esc clears input · tab cycles views · q quits when input is empty.");
      return;
    }
    if (key.tab) {
      setView((current) => nextView(current, key.shift ? -1 : 1));
      return;
    }
    if (key.upArrow || key.downArrow) {
      const delta = key.upArrow ? 1 : -1;
      if (view === "events" || view === "overview") scrollEvents(delta);
      else moveSelection(-delta);
      return;
    }
    if (key.pageUp || key.pageDown) {
      scrollEvents((key.pageUp ? 1 : -1) * Math.max(1, eventRowCount(height) - 1));
      return;
    }
    if (key.leftArrow || key.rightArrow) {
      if (!input) setView((current) => nextView(current, key.leftArrow ? -1 : 1));
      return;
    }
    if (key.backspace || key.delete) {
      setInput((current) => current.slice(0, -1));
      return;
    }
    if (key.ctrl || key.meta || !inputChar || inputChar.length !== 1) return;
    if (!input) {
      if (inputChar === "q") {
        exit();
        return;
      }
      if (inputChar === "?") {
        setView("help");
        return;
      }
      const jump = viewForDigit(inputChar);
      if (jump) {
        setView(jump);
        return;
      }
    }
    if (inputChar >= " ") setInput((current) => current + inputChar);
  });

  useEffect(() => {
    if (view !== "events") setEventScroll(0);
  }, [view]);

  const footer = footerHints(view);
  const rows = contentRows(height);

  return (
    <Box flexDirection="column" width={width} height={height}>
      <ChromeHeader state={state} width={width} />
      <Text> </Text>
      <TabBar segments={tabSegments} active={view} width={width} />
      <Text> </Text>
      <Box height={rows} flexDirection="column">
        {view === "overview" ? <OverviewView state={state} width={width} height={height} /> : null}
        {view === "fleet" ? <FleetView state={state} width={width} height={height} selected={selected.fleet} /> : null}
        {view === "goals" ? <GoalsView state={state} width={width} height={height} selected={selected.goals} /> : null}
        {view === "approvals" ? <ApprovalsView state={state} width={width} height={height} selected={selected.approvals} /> : null}
        {view === "events" ? <EventsView state={state} width={width} height={height} scrollBack={eventScroll} /> : null}
        {view === "help" ? <HelpView width={width} height={height} /> : null}
      </Box>
      <StatusStrip state={state} working={working} width={width} />
      <PromptBar
        input={input}
        connected={state.connection === "connected"}
        width={width}
        placeholder="message the coordinator · /help for commands · tab switches views"
      />
      <Footer hints={footer.hints} right={footer.right} width={width} />
    </Box>
  );
};

function footerHints(view: TuiView): { hints: Array<[string, string]>; right: string } {
  const base: Array<[string, string]> = [["⇥", "views"], ["1-6", "jump"]];
  if (view === "events") {
    return { hints: [...base, ["↑↓", "scroll"], ["pgup/pgdn", "page"], ["esc", "live"]], right: "click tabs · wheel scrolls" };
  }
  if (view === "fleet" || view === "goals" || view === "approvals") {
    return { hints: [...base, ["↑↓", "select"], ["⏎", view === "approvals" ? "prefill /approve" : "activate"], ["esc", "overview"]], right: "click rows · wheel moves" };
  }
  if (view === "help") {
    return { hints: [...base, ["esc", "overview"], ["q", "quit"]], right: "headless control room" };
  }
  return { hints: [...base, ["↑↓", "scroll activity"], ["⏎", "send"], ["q", "quit"]], right: "click tabs · wheel scrolls" };
}

export function runTui(options: RunTuiOptions = {}) {
  const projectRoot = options.projectRoot ?? process.cwd();
  const instance = render(<App projectRoot={projectRoot} connect={options.connect} />, { exitOnCtrlC: true });
  const done = instance.waitUntilExit?.() ?? Promise.resolve();
  return done.finally(() => {
    if (process.stdout.isTTY) process.stdout.write(MOUSE_OFF);
  });
}

function connectProjectDaemon(projectRoot: string) {
  return connectOrStartDaemon({ projectRoot });
}

function useTerminalSize(stdout: NodeJS.WriteStream) {
  const readSize = useCallback(() => ({
    width: boundedDimension(stdout.columns, 96, 60),
    height: boundedDimension(stdout.rows, 28, 20),
  }), [stdout]);
  const [size, setSize] = useState(readSize);

  useEffect(() => {
    const onResize = () => setSize(readSize());
    onResize();
    stdout.on("resize", onResize);
    return () => {
      stdout.off("resize", onResize);
    };
  }, [readSize, stdout]);

  return size;
}

function boundedDimension(value: number | undefined, fallback: number, minimum: number) {
  const size = typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
  return Math.max(minimum, size);
}

function clampIndex(value: number, total: number) {
  return Math.max(0, Math.min(Math.max(0, total - 1), value));
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
