import React from "react";
import { Box, Text } from "ink";
import { controlSummary, healthSummary, shortPath, truncateDisplay, type TuiControlRoomState } from "./model";
import type { TabSegment } from "./layout";
import { HEADLESS_VERSION } from "../version";
import {
  ACCENT,
  backendTone,
  BLUE,
  CHROME,
  connectionTone,
  ERR,
  MUTED,
  OK,
  WARN,
  type TuiView,
} from "./theme";

/** Full-width horizontal divider matching the ContextRelay TUI chrome. */
export function Rule({ width, tone = CHROME }: { width: number; tone?: string }) {
  return <Box paddingX={2}><Text color={tone} wrap="truncate">{"─".repeat(Math.max(1, width - 4))}</Text></Box>;
}

/** Colored status dot; the TUI's glanceable state encoding. */
export function Dot({ tone }: { tone: string }) {
  return <Text color={tone}>● </Text>;
}

/** Backend name rendered in its stable identity color. */
export function BackendName({ backend, bold = false }: { backend: string; bold?: boolean }) {
  return <Text bold={bold} color={backendTone(backend)}>{backend}</Text>;
}

export function ChromeHeader({ state, width }: { state: TuiControlRoomState; width: number }) {
  const tone = connectionTone(state.connection);
  const control = controlSummary(state);
  const health = healthSummary(state);
  const right = width < 120
    ? `${state.connection.toUpperCase()} · mode:${control.orchestrator} · lead:${control.lead} · R${health.ready} B${health.blocked + health.loginRequired}`
    : `${state.connection.toUpperCase()} · mode:${control.orchestrator} · lead:${control.lead} · ready:${health.ready} · blocked:${health.blocked + health.loginRequired}`;
  const leftWidth = Math.max(18, width - right.length - 5);
  return (
    <Box paddingX={2} justifyContent="space-between">
      <Text wrap="truncate">
        <Text color={ACCENT}>◆ </Text>
        <Text bold>HEADLESS</Text>
        <Text color={MUTED}> v{HEADLESS_VERSION}</Text>
        <Text color={CHROME}> · observer</Text>
      </Text>
      {width >= 120 ? <Box width={leftWidth}>
        <Text wrap="truncate"><Text color={CHROME}>{shortPath(state.projectRoot, Math.max(10, leftWidth - 8))}</Text></Text>
      </Box> : null}
      <Text wrap="truncate">
        <Dot tone={tone} /><Text color={tone}>{right}</Text>
      </Text>
    </Box>
  );
}

export function TabBar({ segments, active, width }: { segments: TabSegment[]; active: TuiView; width: number }) {
  const help = segments.find((segment) => segment.view === "help");
  const main = segments.filter((segment) => segment.view !== "help");
  return (
    <Box flexDirection="column" width={width}>
      <Box paddingX={2} width={width} justifyContent="space-between">
        <TabGroup segments={main} active={active} kind="label" />
        {help ? <TabLabel segment={help} active={active === "help"} /> : null}
      </Box>
      <Box paddingX={2} width={width} justifyContent="space-between">
        <TabGroup segments={main} active={active} kind="rule" />
        {help ? <TabRule segment={help} active={active === "help"} /> : null}
      </Box>
    </Box>
  );
}

function TabGroup({ segments, active, kind }: { segments: TabSegment[]; active: TuiView; kind: "label" | "rule" }) {
  return (
    <Text wrap="truncate">
      {segments.map((segment, index) => (
        <React.Fragment key={segment.view}>
          {index > 0 ? <Text color={CHROME}>{"  "}</Text> : null}
          {kind === "label"
            ? <TabLabel segment={segment} active={active === segment.view} />
            : <TabRule segment={segment} active={active === segment.view} />}
        </React.Fragment>
      ))}
    </Text>
  );
}

function TabLabel({ segment, active }: { segment: TabSegment; active: boolean }) {
  const base = segment.badge > 0 ? segment.label.slice(0, -String(segment.badge).length - 1) : segment.label;
  return (
    <Text>
      <Text bold={active} color={active ? ACCENT : MUTED}>{base}</Text>
      {segment.badge > 0 ? (
        <>
          <Text color={CHROME}>·</Text>
          <Text bold color={segment.view === "approvals" ? WARN : ACCENT}>{segment.badge}</Text>
        </>
      ) : null}
    </Text>
  );
}

function TabRule({ segment, active }: { segment: TabSegment; active: boolean }) {
  return <Text color={active ? ACCENT : CHROME}>{tabRule(segment, active)}</Text>;
}

export function tabRule(segment: Pick<TabSegment, "label">, active: boolean) {
  return (active ? "━" : "─").repeat(segment.label.length);
}

export function SectionTitle({ title, hint, tone = BLUE, width }: { title: string; hint?: string; tone?: string; width: number }) {
  return (
    <Box justifyContent="space-between" width={width}>
      <Text wrap="truncate">
        <Text color={tone}>◆ </Text>
        <Text bold color="white">{title.toUpperCase()}</Text>
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
  const failed = /\b(?:failed|error|lost)\b/i.test(state.status);
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

export function Footer({ hints, right, width }: { hints: Array<[string, string]>; right: string; width: number }) {
  return (
    <Box paddingX={2} justifyContent="space-between" width={width}>
      <Text wrap="truncate">
        {hints.map(([key, action], index) => (
          <React.Fragment key={`${key}-${action}`}>
            {index > 0 ? <Text color={CHROME}>   </Text> : null}
            <Text bold color={ACCENT}>{key}</Text>
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
