import React from "react";
import { Box, Text } from "ink";
import { healthSummary, truncateDisplay, type TuiControlRoomState } from "./model";
import { BRAND_TAB_GAP, headerBrand, headerTabsMode, TAB_GAP, type TabSegment } from "./layout";
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
    <Box paddingX={2} paddingTop={1} justifyContent="space-between">
      <Text wrap="truncate">
        <Text color={ACCENT}>◆ </Text>
        <Text bold>HEADLESS</Text>
        {version ? <Text color={MUTED}> v{HEADLESS_VERSION}</Text> : null}
        {inHeader ? <Text>{" ".repeat(BRAND_TAB_GAP)}{segments.map((segment, index) => (
          <React.Fragment key={segment.view}>
            {index > 0 ? <Text>{" ".repeat(TAB_GAP)}</Text> : null}
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
            {index > 0 ? <Text>{" ".repeat(TAB_GAP)}</Text> : null}
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

/** Columns consumed by `paddingX={2}` on both sides of the footer row. */
const FOOTER_PADDING_COLUMNS = 4;
/** Minimum gap kept between the key hints and the right-hand caption. */
const FOOTER_GAP_COLUMNS = 3;

/**
 * Two `space-between` children each truncating independently will overlap once
 * their natural widths exceed the row: the hints get cut mid-word and the
 * caption is jammed against them with no separator. Budget the row instead —
 * the hints are load-bearing (they are how the operator drives the TUI), the
 * caption is decoration, so the caption yields first and is dropped entirely
 * rather than shown as a fragment.
 */
export function footerLayout(hints: Array<[string, string]>, right: string, width: number) {
  const available = Math.max(0, width - FOOTER_PADDING_COLUMNS);
  const hintWidths = hints.map(([key, action]) => key.length + 1 + action.length);
  const hintsWidth = hintWidths.reduce((total, entry, index) => total + entry + (index > 0 ? 3 : 0), 0);
  if (right && hintsWidth + FOOTER_GAP_COLUMNS + right.length <= available) {
    return { visibleHints: hints, right };
  }
  // Drop whole hints from the end rather than slicing one in half; a partial
  // key binding is worse than an absent one.
  let visible = hints.length;
  while (visible > 0) {
    const used = hintWidths.slice(0, visible).reduce((total, entry, index) => total + entry + (index > 0 ? 3 : 0), 0);
    if (used <= available) break;
    visible -= 1;
  }
  return { visibleHints: hints.slice(0, visible), right: "" };
}

export function Footer({ hints, right, width }: { hints: Array<[string, string]>; right: string; width: number }) {
  const { visibleHints, right: caption } = footerLayout(hints, right, width);
  return (
    <Box paddingX={2} justifyContent="space-between" width={width}>
      <Text wrap="truncate">
        {visibleHints.map(([key, action], index) => (
          <React.Fragment key={`${key}-${action}`}>
            {index > 0 ? <Text color={CHROME}>   </Text> : null}
            <Text bold color={ACCENT}>{key}</Text>
            <Text color={MUTED}> {action}</Text>
          </React.Fragment>
        ))}
      </Text>
      {caption ? <Text color={CHROME} wrap="truncate">{caption}</Text> : null}
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
