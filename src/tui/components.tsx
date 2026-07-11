import React from "react";
import { Box, Text } from "ink";
import { shortPath, truncateDisplay, type TuiControlRoomState } from "./model";
import type { TabSegment } from "./layout";
import {
  ACCENT,
  BLUE,
  CHROME,
  connectionTone,
  ERR,
  INK,
  MUTED,
  OK,
  SURFACE,
  WARN,
  type TuiView,
} from "./theme";

export function ChromeHeader({ state, width }: { state: TuiControlRoomState; width: number }) {
  const tone = connectionTone(state.connection);
  const agents = state.fleetHealth.length;
  const pending = state.approvals.filter((approval) => approval.status === "pending").length;
  const queued = state.orchestration.queuedJobs;
  const connection = state.connection.toUpperCase();
  // Plain-text estimate of the rendered right column, used only to size the
  // left column so the two never collide.
  const right = ` ${connection}  ${state.orchestration.mode} · agents ${agents} · approvals ${pending} · queue ${queued}`;
  const leftWidth = Math.max(18, width - right.length - 4);
  const sep = <Text color={CHROME}>{" · "}</Text>;
  return (
    <Box paddingX={2} justifyContent="space-between">
      <Box width={leftWidth}>
        <Text wrap="truncate">
          <Text bold color={ACCENT}>⬢ </Text>
          <Text bold color="white">headless</Text>
          <Text color={MUTED}> control room</Text>
          <Text color={CHROME}>  {shortPath(state.projectRoot, Math.max(10, leftWidth - 26))}</Text>
        </Text>
      </Box>
      <Text wrap="truncate">
        <Text backgroundColor={tone} color={INK} bold>{` ${connection} `}</Text>
        <Text color={CHROME}>{"  "}</Text>
        <Text bold={state.orchestration.enabled} color={state.orchestration.enabled ? ACCENT : MUTED}>{state.orchestration.mode}</Text>
        {sep}
        <Text color={MUTED}>agents </Text>
        <Text color="white">{agents}</Text>
        {sep}
        <Text color={pending > 0 ? WARN : MUTED}>approvals </Text>
        <Text bold={pending > 0} color={pending > 0 ? WARN : "white"}>{pending}</Text>
        {sep}
        <Text color={MUTED}>queue </Text>
        <Text color="white">{queued}</Text>
      </Text>
    </Box>
  );
}

export function TabBar({ segments, active, width }: { segments: TabSegment[]; active: TuiView; width: number }) {
  const help = segments.find((segment) => segment.view === "help");
  const main = segments.filter((segment) => segment.view !== "help");
  return (
    <Box paddingX={2} width={width} justifyContent="space-between">
      <Text wrap="truncate">
        {main.map((segment, index) => (
          <React.Fragment key={segment.view}>
            {index > 0 ? <Text color={CHROME}>{"  "}</Text> : null}
            <TabLabel segment={segment} active={active === segment.view} />
          </React.Fragment>
        ))}
      </Text>
      {help ? <TabLabel segment={help} active={active === "help"} /> : null}
    </Box>
  );
}

function TabLabel({ segment, active }: { segment: TabSegment; active: boolean }) {
  const base = segment.badge > 0 ? segment.label.slice(0, -String(segment.badge).length - 1) : segment.label;
  // No horizontal padding: the tab's hit-test columns are derived from the raw
  // label width, so the highlight must not change the rendered character count.
  // Active tab = dark SURFACE fill + bold blue + underline, matching the tpn
  // "darker fill" active-tab treatment and linking it to its SURFACE panel.
  return (
    <Text>
      <Text bold={active} underline={active} color={active ? BLUE : MUTED} backgroundColor={active ? SURFACE : undefined}>{base}</Text>
      {segment.badge > 0 ? (
        <>
          <Text color={CHROME}>·</Text>
          <Text bold color={segment.view === "approvals" ? WARN : ACCENT}>{segment.badge}</Text>
        </>
      ) : null}
    </Text>
  );
}

export function SectionTitle({ title, hint, tone = BLUE, width }: { title: string; hint?: string; tone?: string; width: number }) {
  return (
    <Box justifyContent="space-between" width={width}>
      <Text wrap="truncate">
        <Text color={tone}>▍</Text>
        <Text bold color="white">{title}</Text>
      </Text>
      {hint ? <Text color={CHROME} wrap="truncate">{hint}</Text> : null}
    </Box>
  );
}

export function KeyValue({ label, children, labelWidth = 10 }: React.PropsWithChildren<{ label: string; labelWidth?: number }>) {
  return (
    <Text wrap="truncate">
      <Text color={CHROME}>{label.padEnd(labelWidth)}</Text>
      {children}
    </Text>
  );
}

export function EmptyHint({ text }: { text: string }) {
  return <Text color={MUTED} wrap="truncate">  {text}</Text>;
}

export function StatusStrip({ state, working, width }: { state: TuiControlRoomState; working: boolean; width: number }) {
  const failed = /failed|error|lost/i.test(state.status);
  const tone = failed ? ERR : working ? WARN : OK;
  const label = failed ? "ERROR" : working ? "WORKING" : "READY";
  return (
    <Box paddingX={2} flexShrink={0}>
      <Text wrap="truncate">
        <Text bold backgroundColor={tone} color={INK}>{` ${label} `}</Text>
        <Text color="white">{`  ${truncateDisplay(state.status, Math.max(8, width - label.length - 16))}`}</Text>
      </Text>
    </Box>
  );
}

export function PromptBar({
  input,
  connected,
  width,
  placeholder,
}: {
  input: string;
  connected: boolean;
  width: number;
  placeholder: string;
}) {
  const [cursorVisible, setCursorVisible] = React.useState(true);
  React.useEffect(() => {
    const interval = setInterval(() => setCursorVisible((visible) => !visible), 530);
    return () => clearInterval(interval);
  }, []);
  const accent = connected ? ACCENT : WARN;
  const innerWidth = Math.max(1, width - 7);
  return (
    <Box marginX={2} paddingY={0} flexShrink={0}>
      <Text color={accent}>▎</Text>
      <Box backgroundColor={SURFACE} paddingX={1} width={innerWidth}>
        <Text wrap="truncate">
          <Text bold color={accent}>❯ </Text>
          {input
            ? <Text color="white">{tail(input, innerWidth - 4)}</Text>
            : <Text color={CHROME}>{placeholder}</Text>}
          <Text color={cursorVisible ? accent : SURFACE}>▌</Text>
        </Text>
      </Box>
    </Box>
  );
}

export function Footer({ hints, right, width }: { hints: Array<[string, string]>; right: string; width: number }) {
  return (
    <Box paddingX={2} justifyContent="space-between" width={width}>
      <Text wrap="truncate">
        {hints.map(([key, action], index) => (
          <React.Fragment key={`${key}-${action}`}>
            {index > 0 ? <Text color={CHROME}>  </Text> : null}
            <Text color={BLUE}>{key}</Text>
            <Text color={MUTED}> {action}</Text>
          </React.Fragment>
        ))}
      </Text>
      <Text color={CHROME} wrap="truncate">{right}</Text>
    </Box>
  );
}

export function GateChips({ gates }: { gates: Array<{ id: string; status: string }> }) {
  if (gates.length === 0) return <Text color={MUTED}>no gates reported</Text>;
  return (
    <Text wrap="truncate">
      {gates.map((gate, index) => (
        <React.Fragment key={gate.id}>
          {index > 0 ? <Text color={CHROME}>  </Text> : null}
          <Text color={gateGlyphTone(gate.status)}>{gate.id} {gateGlyph(gate.status)}</Text>
        </React.Fragment>
      ))}
    </Text>
  );
}

function gateGlyph(status: string): string {
  return status === "passed" ? "✓" : status === "failed" ? "✗" : status === "not_required" ? "–" : "…";
}

function gateGlyphTone(status: string): string {
  return status === "passed" ? OK : status === "failed" ? ERR : status === "not_required" ? CHROME : MUTED;
}

function tail(value: string, max: number): string {
  return value.length <= max ? value : `…${value.slice(-(max - 1))}`;
}
