import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Box, Text, render, useApp, useInput, useStdout, type Key } from "ink";
import type { RunEvent } from "../contracts/run";
import { connectOrStartDaemon } from "../daemon/connect";
import type { HeadlessDaemonClient } from "../daemon/client";
import { TuiController, runReconnectLoop, subscribeControlRoom } from "./controller";
import { buildControlRoomView, initialControlRoomState, type TuiControlRoomState } from "./model";

export type RunTuiOptions = {
  projectRoot?: string;
  connect?: (projectRoot: string) => Promise<HeadlessDaemonClient>;
};

export type AppProps = Required<Pick<RunTuiOptions, "projectRoot">> & Pick<RunTuiOptions, "connect">;

export const App: React.FC<AppProps> = ({ projectRoot, connect = connectProjectDaemon }) => {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const [state, setState] = useState(() => initialControlRoomState(projectRoot));
  const [input, setInput] = useState("");
  const [scrollBack, setScrollBack] = useState(0);
  const stateRef = useRef(state);
  const controllerRef = useRef<TuiController | null>(null);

  const patchState = useCallback((patch: Partial<TuiControlRoomState>) => {
    setState((current) => {
      const next = { ...current, ...patch };
      stateRef.current = next;
      return next;
    });
  }, []);
  const setStatus = useCallback((status: string) => patchState({ status }), [patchState]);

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
          setStatus("Connected · free text is routed to the active goal coordinator.");
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

  const width = stdout.columns || 96;
  const height = stdout.rows || 28;
  const view = useMemo(() => buildControlRoomView(state, width, height), [height, state, width]);
  const eventRows = view.eventRows;
  const visibleEvents = useMemo(() => {
    const start = Math.max(0, state.events.length - eventRows - scrollBack);
    return state.events.slice(start, start + eventRows);
  }, [eventRows, scrollBack, state.events]);

  useInput((inputChar: string, key: Key) => {
    const isReturn = key.return || inputChar === "\r" || inputChar === "\n";
    if (isReturn) {
      const command = input.trim();
      if (command) {
        const controller = controllerRef.current;
        if (controller) controller.execute(command);
        else setStatus("Daemon is reconnecting; input remains editable until connection returns.");
      }
      setInput("");
      return;
    }
    if (key.escape) {
      if (input) setInput("");
      else setStatus("Esc clears input · ↑ older events · ↓ newer events · q quits when input is empty.");
      return;
    }
    if (key.upArrow) {
      setScrollBack((current) => Math.min(Math.max(0, state.events.length - eventRows), current + 1));
      return;
    }
    if (key.downArrow) {
      setScrollBack((current) => Math.max(0, current - 1));
      return;
    }
    if (key.ctrl && inputChar.toLowerCase() === "c") {
      exit();
      return;
    }
    if (key.backspace || key.delete) {
      setInput((current) => current.slice(0, -1));
      return;
    }
    if (inputChar === "q" && !input) {
      exit();
      return;
    }
    if (inputChar && !key.ctrl && !key.meta && inputChar.length === 1) {
      setInput((current) => current + inputChar);
    }
  });

  const activeProfile = state.fleetProfiles.find((profile) => profile.id === state.activeFleetProfileId);
  const activeGoal = state.goals.find((goal) => goal.id === state.activeGoalId);

  return (
    <Box flexDirection="column" height={height} width={width}>
      <Box borderStyle="single" borderColor={state.connection === "connected" ? "cyan" : "yellow"} paddingX={1}>
        <Text bold color="cyan">{view.title}</Text>
      </Box>
      {!view.compact && <Text dimColor wrap="truncate"> {view.projectLine}</Text>}

      <Box flexDirection={view.narrow ? "column" : "row"}>
        <Panel title={`Fleet${activeProfile ? ` · ${activeProfile.name}` : ""}`} color="green" width={view.narrow ? "100%" : "50%"}>
          {view.fleetLines.map((line, index) => <Text key={`${line}-${index}`} wrap="truncate">{line}</Text>)}
          <Text dimColor wrap="truncate">{view.queueLine}</Text>
        </Panel>
        <Panel title={`Goal${activeGoal ? ` · ${activeGoal.id}` : ""}`} color="blue" width={view.narrow ? "100%" : "50%"}>
          {view.goalLines.map((line, index) => <Text key={`${line}-${index}`} wrap="truncate">{line}</Text>)}
          {!view.compact && <Text dimColor>/goal · /goal-write · /use-goal · /leader · /cancel-goal</Text>}
        </Panel>
      </Box>

      {!view.compact && (
        <Box flexDirection={view.narrow ? "column" : "row"}>
          <Panel title="Approval inbox" color="yellow" width={view.narrow ? "100%" : "50%"}>
            {view.approvalLines.map((line, index) => <Text key={`${line}-${index}`} wrap="truncate">{line}</Text>)}
          </Panel>
          <Panel title="Candidate + gates" color="magenta" width={view.narrow ? "100%" : "50%"}>
            {view.candidateLines.map((line, index) => <Text key={`${line}-${index}`} wrap="truncate">{line}</Text>)}
          </Panel>
        </Box>
      )}

      <Box flexGrow={1} minHeight={eventRows + view.activityLines.length + 2} borderStyle="round" borderColor="gray" paddingX={1} flexDirection="column">
        <Text bold>Live events · turns {state.turns.length} · messages {state.messages.length}</Text>
        {view.activityLines.map((line, index) => (
          <Text key={`activity-${index}-${line}`} color="cyan" wrap="truncate">{line}</Text>
        ))}
        {visibleEvents.length === 0 && view.activityLines.length === 0
          ? <Text dimColor>No run events yet.</Text>
          : visibleEvents.map((event) => (
              <Text key={event.eventId} wrap="truncate">[{eventTime(event)}] {event.kind} {eventSummary(event)}</Text>
            ))}
        <Text dimColor>↑↓ {state.events.length} events · /ack-message · /help · q quit</Text>
      </Box>

      <Box borderStyle="single" borderColor={state.approvals.some((approval) => approval.status === "pending") ? "yellow" : "blue"} paddingX={1}>
        <Text wrap="truncate">{state.status}</Text>
      </Box>
      <Box borderStyle="single" borderColor="green" paddingX={1}>
        <Text color="green">&gt; </Text>
        <Text wrap="truncate">{input || <Text color="gray">message active coordinator or /help</Text>}</Text>
      </Box>
    </Box>
  );
};

function Panel(props: React.PropsWithChildren<{ title: string; color: string; width: string }>) {
  return (
    <Box borderStyle="round" borderColor={props.color} width={props.width} paddingX={1} flexDirection="column">
      <Text bold wrap="truncate">{props.title}</Text>
      {props.children}
    </Box>
  );
}

export function runTui(options: RunTuiOptions = {}) {
  const projectRoot = options.projectRoot ?? process.cwd();
  const instance = render(<App projectRoot={projectRoot} connect={options.connect} />, { exitOnCtrlC: true });
  return instance.waitUntilExit?.() ?? Promise.resolve();
}

function connectProjectDaemon(projectRoot: string) {
  return connectOrStartDaemon({ projectRoot });
}

function eventTime(event: RunEvent) {
  return new Date(event.timestamp).toLocaleTimeString().slice(0, 8);
}

function eventSummary(event: RunEvent) {
  if (event.kind === "stdout" || event.kind === "stderr") return event.text;
  if (event.kind === "lifecycle") return `${event.state}${event.detail ? ` · ${event.detail}` : ""}`;
  if (event.kind === "policy") return `${event.decision}: ${event.reason}`;
  if (event.kind === "tool") return `${event.name}: ${event.summary}`;
  if (event.kind === "artifact") return `${event.artifactKind}: ${event.summary}`;
  if (event.kind === "usage") return `input=${event.usage.input ?? "?"} output=${event.usage.output ?? "?"} cost=${event.cost.amountUsd ?? "?"}`;
  if (event.kind === "completion") return `${event.result.status}: ${event.result.output}`;
  return "";
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
