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

export type TuiView = "overview" | "fleet" | "goals" | "approvals" | "events" | "config" | "help";

export const TUI_VIEWS: TuiView[] = ["overview", "fleet", "goals", "approvals", "events", "config", "help"];

export const VIEW_LABELS: Record<TuiView, string> = {
  // Keep the legacy tab width for mouse/layout compatibility; the view itself
  // presents this as the Home summary in its content and help text.
  overview: "Overview",
  fleet: "Fleet",
  goals: "Goals",
  approvals: "Approvals",
  events: "Events",
  config: "Config",
  help: "Help",
};

/** 1-based terminal row of the tab bar; kept in sync with the fixed chrome in App.tsx. */
export const TAB_ROW = 3;
/** 1-based terminal row where view content starts. */
export const CONTENT_TOP = 5;
/** Rows of view chrome (section title + column header) above selectable list rows. */
export const LIST_OFFSET = 2;
/** Terminal rows consumed by fixed observer chrome outside the content area (header, rule, tabs ×2, rule, status, footer). */
export const FIXED_ROWS = 7;

/**
 * Stable identity colors for the four advertised backends, used wherever an
 * agent/backend is named so the fleet reads at a glance. Aliases cover both
 * the backend ids and the short host names.
 */
export const BACKEND_TONES: Record<string, string> = {
  "claude-code": "#fb923c",
  claude: "#fb923c",
  codex: "#8aa7ff",
  opencode: "#34d399",
  "grok-build": "#c4b5fd",
  grok: "#c4b5fd",
};

export function backendTone(backend: string): string {
  return BACKEND_TONES[backend] ?? MUTED;
}

/** Tone for a fleet/backend readiness label. */
export function readinessTone(readiness: string): string {
  if (readiness === "Ready") return OK;
  if (readiness === "Disabled") return CHROME;
  if (/blocked|unavailable|unsupported/i.test(readiness)) return ERR;
  return WARN;
}

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
