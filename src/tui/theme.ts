export const BLUE = "#8aa7ff";
export const ACCENT = "#22d3ee";
export const MUTED = "#8b8b94";
export const CHROME = "#52525b";
export const SURFACE = "#252525";
export const SURFACE_2 = "#202023";
export const OK = "#4ade80";
export const WARN = "#fbbf24";
export const ERR = "#f87171";
export const VIOLET = "#c4b5fd";

/** Highlight fill for the selected list row and the active tab. */
export const SELECT_BG = "#2b3154";
/** Brighter foreground for secondary text sitting on {@link SELECT_BG}. */
export const SELECT_FG = "#c7d0f0";
/** Near-black ink for text printed on a saturated pill background. */
export const INK = "#0b0b12";

export type TuiView = "overview" | "fleet" | "goals" | "approvals" | "events" | "help";

export const TUI_VIEWS: TuiView[] = ["overview", "fleet", "goals", "approvals", "events", "help"];

export const VIEW_LABELS: Record<TuiView, string> = {
  overview: "Overview",
  fleet: "Fleet",
  goals: "Goals",
  approvals: "Approvals",
  events: "Events",
  help: "Help",
};

/** 1-based terminal row of the tab bar; kept in sync with the fixed chrome in App.tsx. */
export const TAB_ROW = 3;
/** 1-based terminal row where view content starts. */
export const CONTENT_TOP = 5;
/** Rows of view chrome (section title + column header) above selectable list rows. */
export const LIST_OFFSET = 2;
/** Terminal rows consumed by fixed chrome outside the content area. */
export const FIXED_ROWS = 9;

export function goalStateGlyph(state: string): { glyph: string; tone: string } {
  switch (state) {
    case "queued": return { glyph: "○", tone: MUTED };
    case "planning": return { glyph: "◔", tone: BLUE };
    case "delegating": return { glyph: "◑", tone: BLUE };
    case "active": return { glyph: "●", tone: ACCENT };
    case "critiquing": return { glyph: "◕", tone: VIOLET };
    case "gating": return { glyph: "◍", tone: VIOLET };
    case "waiting_approval": return { glyph: "◉", tone: WARN };
    case "integrating": return { glyph: "◎", tone: WARN };
    case "succeeded": return { glyph: "✓", tone: OK };
    case "failed": return { glyph: "✗", tone: ERR };
    case "cancelled": return { glyph: "⊘", tone: MUTED };
    case "timed_out": return { glyph: "◷", tone: ERR };
    default: return { glyph: "·", tone: MUTED };
  }
}

export function eventTone(kind: string, detail?: string): string {
  switch (kind) {
    case "lifecycle": return BLUE;
    case "stdout": return MUTED;
    case "stderr": return WARN;
    case "policy": return detail === "allow" || detail === "approved" ? OK : WARN;
    case "tool": return ACCENT;
    case "artifact": return OK;
    case "usage": return VIOLET;
    case "completion": return detail === "succeeded" ? OK : detail === "failed" ? ERR : BLUE;
    default: return MUTED;
  }
}

export function gateTone(status: string): string {
  switch (status) {
    case "passed": return OK;
    case "failed": return ERR;
    case "not_required": return CHROME;
    default: return MUTED;
  }
}

export function connectionTone(connection: string): string {
  return connection === "connected" ? OK : connection === "disconnected" ? ERR : WARN;
}
