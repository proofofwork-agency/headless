import { CONTENT_TOP, FIXED_ROWS, HEADER_TABS_MIN_WIDTH, LIST_OFFSET, TAB_ROW, TUI_VIEWS, VIEW_LABELS, type TuiView } from "./theme";
import { HEADLESS_VERSION } from "../version";

export type TabSegment = {
  view: TuiView;
  label: string;
  badge: number;
  from: number;
  to: number;
};

export type MouseEvent = {
  x: number;
  y: number;
  kind: "press" | "wheel-up" | "wheel-down";
};

export type ListZone = {
  view: TuiView;
  fromY: number;
  toY: number;
  fromX: number;
  toX: number;
  start: number;
  total: number;
};

export type HitZones = {
  tabY: number;
  tabs: TabSegment[];
  list: ListZone | null;
};

export type HitAction =
  | { kind: "view"; view: TuiView }
  | { kind: "row"; index: number };

/** First terminal column of content inside paddingX={2} chrome (1-based). */
const CONTENT_START_X = 3;
/**
 * Spaces between the header brand and the first tab, and between tabs. Exported
 * so ChromeHeader renders the exact same spacers the hit-zone math assumes —
 * they must never drift or mouse clicks land on the wrong tab. Tuned for the
 * airier ContextRelay-style header spacing around the menu items.
 */
export const BRAND_TAB_GAP = 4;
export const TAB_GAP = 2;

export function contentRows(height: number): number {
  return Math.max(4, height - FIXED_ROWS);
}

/** Whether the tabs render inside the header row (ContextRelay style) at this width. */
export function headerTabsMode(width: number): boolean {
  return width >= HEADER_TABS_MIN_WIDTH;
}

/** 1-based terminal row where tab labels live (header row, or the compact row under it). */
export function tabRowFor(width: number): number {
  return headerTabsMode(width) ? TAB_ROW : TAB_ROW + 1;
}

/** The header brand text; the tab x-offsets are derived from its exact width. */
export function headerBrand(width: number): string {
  return width >= 132 ? `◆ HEADLESS v${HEADLESS_VERSION}` : "◆ HEADLESS";
}

/**
 * Tab segments with 1-based inclusive terminal columns. In header mode the tabs
 * start after the brand; in the compact fallback they own the row below the
 * header. Every label is rendered with one leading digit and padding spaces so
 * active/inactive widths are identical and hit zones stay exact.
 */
export function buildTabLayout(width: number, badges: Partial<Record<TuiView, number>> = {}): TabSegment[] {
  const segments: TabSegment[] = [];
  let cursor = headerTabsMode(width)
    ? CONTENT_START_X + headerBrand(width).length + BRAND_TAB_GAP
    : CONTENT_START_X;
  for (const [index, view] of TUI_VIEWS.entries()) {
    const badge = badges[view] ?? 0;
    const name = VIEW_LABELS[view].toLowerCase();
    const label = ` ${index + 1} ${badge > 0 ? `${name}·${badge}` : name} `;
    segments.push({ view, label, badge, from: cursor, to: cursor + label.length - 1 });
    cursor += label.length + TAB_GAP;
  }
  return segments;
}

export function buildHitZones(options: {
  width: number;
  height: number;
  view: TuiView;
  badges?: Partial<Record<TuiView, number>>;
  list?: { rows: number; start: number; total: number; paneWidth?: number } | null;
}): HitZones {
  const { width, height, view } = options;
  const list = options.list ?? null;
  const listRows = list ? Math.max(0, Math.min(list.rows, contentRows(height) - LIST_OFFSET)) : 0;
  return {
    tabY: tabRowFor(width),
    tabs: buildTabLayout(width, options.badges ?? {}),
    list: list && listRows > 0
      ? {
          view,
          fromY: CONTENT_TOP + LIST_OFFSET,
          toY: CONTENT_TOP + LIST_OFFSET + listRows - 1,
          fromX: 1,
          toX: Math.max(1, Math.min(width, list.paneWidth ?? width)),
          start: list.start,
          total: list.total,
        }
      : null,
  };
}

export function hitTest(x: number, y: number, zones: HitZones): HitAction | undefined {
  if (y === zones.tabY) {
    const tab = zones.tabs.find((segment) => x >= segment.from && x <= segment.to);
    return tab ? { kind: "view", view: tab.view } : undefined;
  }
  const list = zones.list;
  if (list && y >= list.fromY && y <= list.toY && x >= list.fromX && x <= list.toX) {
    const index = list.start + (y - list.fromY);
    return index < list.total ? { kind: "row", index } : undefined;
  }
  return undefined;
}

/** First visible index of a list window that keeps `selected` in view. */
export function listWindowStart(selected: number, visibleCount: number, total: number): number {
  const maxStart = Math.max(0, total - visibleCount);
  const preferred = selected < visibleCount ? 0 : selected - visibleCount + 1;
  return Math.max(0, Math.min(preferred, maxStart));
}

const MOUSE_SEQUENCE = /(?:\x1b)?\[<(\d+);(\d+);(\d+)([mM])/g;

/**
 * Decodes SGR mouse reports (\x1b[<b;x;yM). Ink can deliver several reports in
 * one chunk (fast wheel scrolling), so every report in the chunk is returned.
 */
export function parseMouseEvents(input: string): MouseEvent[] {
  if (!input.includes("[<")) return [];
  const events: MouseEvent[] = [];
  MOUSE_SEQUENCE.lastIndex = 0;
  for (let match = MOUSE_SEQUENCE.exec(input); match; match = MOUSE_SEQUENCE.exec(input)) {
    const button = Number(match[1]);
    const x = Number(match[2]);
    const y = Number(match[3]);
    if (!Number.isFinite(button) || !Number.isFinite(x) || !Number.isFinite(y)) continue;
    if ((button & 64) !== 0) {
      events.push({ x, y, kind: (button & 1) === 0 ? "wheel-up" : "wheel-down" });
      continue;
    }
    // Left-button press with any shift/alt/ctrl modifier; releases ("m") are ignored.
    if (match[4] === "M" && (button & 0b10000011) === 0) {
      events.push({ x, y, kind: "press" });
    }
  }
  return events;
}

export function nextView(view: TuiView, direction: 1 | -1 = 1): TuiView {
  const index = TUI_VIEWS.indexOf(view);
  const next = (index + direction + TUI_VIEWS.length) % TUI_VIEWS.length;
  return TUI_VIEWS[next] ?? "overview";
}

export function viewForDigit(digit: string): TuiView | undefined {
  const index = Number(digit) - 1;
  return Number.isInteger(index) && index >= 0 ? TUI_VIEWS[index] : undefined;
}
