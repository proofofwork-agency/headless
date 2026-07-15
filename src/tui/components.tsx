import React from "react";
import { Box, Text } from "ink";
import { healthSummary, truncateDisplay, type TuiControlRoomState } from "./model";
import { headerBrand, headerTabsMode, type TabSegment } from "./layout";
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

export function ChromeHeader({ state, width, segments, active }: {
  state: TuiControlRoomState;
  width: number;
  segments: TabSegment[];
  active: TuiView;
}) {
  const tone = connectionTone(state.connection);
  const health = healthSummary(state);
  const inHeader = headerTabsMode(width);
  const brand = headerBrand(width);
  const version = brand.includes(HEADLESS_VERSION);
  const right = width >= 150
    ? `${state.connection.toUpperCase()} · ready:${health.ready} · blocked:${health.blocked + health.loginRequired}`
    : width >= 120
      ? `${state.connection.toUpperCase()} · R${health.ready} B${health.blocked + health.loginRequired}`
      : state.connection.toUpperCase();
  return (
    <Box paddingX={2} justifyContent="space-between">
      <Text wrap="truncate">
        <Text color={ACCENT}>◆ </Text>
        <Text bold>HEADLESS</Text>
        {version ? <Text color={MUTED}> v{HEADLESS_VERSION}</Text> : null}
        {inHeader ? <Text>  {segments.map((segment, index) => (
          <React.Fragment key={segment.view}>
            {index > 0 ? <Text> </Text> : null}
            <TabLabel segment={segment} active={active === segment.view} />
          </React.Fragment>
        ))}</Text> : null}
      </Text>
      <Text wrap="truncate">
        <Dot tone={tone} /><Text color={tone}>{right}</Text>
      </Text>
    </Box>
  );
}

/** Compact single-row tab bar used below the header when the terminal is narrow. */
export function CompactTabRow({ segments, active }: { segments: TabSegment[]; active: TuiView }) {
  return (
    <Box paddingX={2}>
      <Text wrap="truncate">
        {segments.map((segment, index) => (
          <React.Fragment key={segment.view}>
            {index > 0 ? <Text> </Text> : null}
            <TabLabel segment={segment} active={active === segment.view} />
          </React.Fragment>
        ))}
      </Text>
    </Box>
  );
}

function TabLabel({ segment, active }: { segment: TabSegment; active: boolean }) {
  return active
    ? <Text bold color={ACCENT} inverse>{segment.label}</Text>
    : <Text color={MUTED} dimColor>{segment.label}</Text>;
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
