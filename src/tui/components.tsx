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
  const right = `● ${state.connection} · ${state.orchestration.mode} · agents ${agents} · approvals ${pending} · queue ${state.orchestration.queuedJobs}`;
  const leftWidth = Math.max(18, width - right.length - 5);
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
        <Text color={tone}>● </Text>
        <Text color={tone}>{state.connection}</Text>
        <Text color={CHROME}> · </Text>
        <Text color={state.orchestration.enabled ? ACCENT : MUTED}>{state.orchestration.mode}</Text>
        <Text color={CHROME}> · </Text>
        <Text color={MUTED}>agents </Text>
        <Text color="white">{agents}</Text>
        <Text color={CHROME}> · </Text>
        <Text color={pending > 0 ? WARN : MUTED}>approvals {pending}</Text>
        <Text color={CHROME}> · </Text>
        <Text color={MUTED}>queue {state.orchestration.queuedJobs}</Text>
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
  return (
    <Text>
      <Text bold={active} color={active ? BLUE : MUTED} underline={active}>{base}</Text>
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
  const label = failed ? "error" : working ? "working" : "ready";
  return (
    <Box paddingX={2} flexShrink={0}>
      <Text wrap="truncate">
        <Text bold color={tone}>{label.padEnd(8)}</Text>
        <Text color="white">{truncateDisplay(state.status, Math.max(8, width - 14))}</Text>
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
  const innerWidth = Math.max(1, width - 6);
  return (
    <Box marginX={2} backgroundColor={SURFACE} paddingX={1} paddingY={0} flexShrink={0}>
      <Box width={innerWidth}>
        <Text wrap="truncate">
          <Text bold color={connected ? ACCENT : WARN}>❯ </Text>
          {input
            ? <Text color="white">{tail(input, innerWidth - 4)}</Text>
            : <Text color={CHROME}>{placeholder}</Text>}
          <Text color={cursorVisible ? BLUE : SURFACE}>▌</Text>
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
