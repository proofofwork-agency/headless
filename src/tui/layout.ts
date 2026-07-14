import { CONTENT_TOP, FIXED_ROWS, LIST_OFFSET, TAB_ROW, TUI_VIEWS, VIEW_LABELS, type TuiView } from "./theme";

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
const TAB_GAP = 2;

export function contentRows(height: number): number {
  return Math.max(4, height - FIXED_ROWS);
}

export function buildTabLayout(width: number, badges: Partial<Record<TuiView, number>> = {}): TabSegment[] {
  const segments: TabSegment[] = [];
  let cursor = CONTENT_START_X;
  for (const view of TUI_VIEWS) {
    if (view === "help") continue;
    const badge = badges[view] ?? 0;
    const label = badge > 0 ? `${VIEW_LABELS[view]}·${badge}` : VIEW_LABELS[view];
    segments.push({ view, label, badge, from: cursor, to: cursor + label.length - 1 });
    cursor += label.length + TAB_GAP;
  }
  const helpLabel = VIEW_LABELS.help;
  const helpTo = Math.max(cursor, width - 2);
  segments.push({ view: "help", label: helpLabel, badge: 0, from: Math.max(cursor, helpTo - helpLabel.length + 1), to: helpTo });
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
    tabY: TAB_ROW,
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
  if (y === zones.tabY || y === zones.tabY + 1) {
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
