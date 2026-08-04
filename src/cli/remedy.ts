/**
 * Error → copy-paste next command matrix (Product Gate P.REMEDY).
 * Keep messages short; prefer exact argv the operator can run.
 */

export type Remedy = {
  code: string;
  title: string;
  explanation: string;
  /** Preferred shell command; may include placeholders like <cwd>. */
  command: string;
};

const TOP_REMEDIES: Remedy[] = [
  {
    code: "TRUST_REQUIRED",
    title: "Trust required",
    explanation: "Native login needs project trust plus unrestricted-egress acknowledgement.",
    command: "headless project trust grant --allow-native-direct-unrestricted --cwd <cwd>",
  },
  {
    code: "trust_required",
    title: "Trust required",
    explanation: "Native login needs project trust plus unrestricted-egress acknowledgement.",
    command: "headless project trust grant --allow-native-direct-unrestricted --cwd <cwd>",
  },
  {
    code: "LOGIN_REQUIRED",
    title: "Login required",
    explanation: "Supported provider login state was not found for the selected auth mode.",
    command: "headless doctor --cwd <cwd>",
  },
  {
    code: "login_required",
    title: "Login required",
    explanation: "Supported provider login state was not found for the selected auth mode.",
    command: "headless doctor --cwd <cwd>",
  },
  {
    code: "NATIVE_AUTH_UNAVAILABLE",
    title: "Native auth unavailable",
    explanation: "The backend capsule or setup-token is missing, invalid, or not importable under containment.",
    command: "headless doctor --cwd <cwd>",
  },
  {
    code: "CONTAINMENT_UNAVAILABLE",
    title: "Containment unavailable",
    explanation: "Required OS containment could not be established. Headless does not silently downgrade.",
    command: "headless doctor --cwd <cwd>",
  },
  {
    code: "UNSUPPORTED_PLATFORM",
    title: "Unsupported platform",
    explanation: "Headless v0.2 requires macOS or Linux.",
    command: "headless doctor --cwd <cwd>",
  },
  {
    code: "POLICY_DENIED",
    title: "Policy denied",
    explanation: "Project policy, budget, or mode rejected the request before launch.",
    command: "headless status --cwd <cwd>",
  },
  {
    code: "BUDGET_EXHAUSTED",
    title: "Budget exhausted",
    explanation: "Request, token, or cost quota has no remaining capacity.",
    command: "headless experimental budget list --cwd <cwd>",
  },
  {
    code: "INVALID_REQUEST",
    title: "Invalid request",
    explanation: "Flags or payload failed validation.",
    command: "headless --help",
  },
  {
    code: "TIMED_OUT",
    title: "Timed out",
    explanation: "The run exceeded its total lifecycle deadline.",
    command: "headless exec --auth-mode native-login --profile read-only-native --timeout-ms 300000 --cwd <cwd> -- \"retry with a longer timeout\"",
  },
  {
    code: "RATE_LIMITED",
    title: "Rate limited",
    explanation: "The provider temporarily refused new work.",
    command: "headless doctor --cwd <cwd>",
  },
  {
    code: "PROVIDER_UNAVAILABLE",
    title: "Provider unavailable",
    explanation: "The backend CLI is missing from PATH or failed health.",
    command: "headless doctor --cwd <cwd>",
  },
  {
    code: "INTERNAL_ERROR",
    title: "Internal error",
    explanation: "The daemon or runner hit an unexpected failure.",
    command: "headless daemon status --cwd <cwd>",
  },
];

const byCode = new Map(TOP_REMEDIES.map((remedy) => [remedy.code.toUpperCase(), remedy]));

/** Codes Product Gate P expects to cover (case-insensitive). */
export const PRODUCT_GATE_REMEDY_CODES = [
  "TRUST_REQUIRED",
  "LOGIN_REQUIRED",
  "NATIVE_AUTH_UNAVAILABLE",
  "CONTAINMENT_UNAVAILABLE",
  "UNSUPPORTED_PLATFORM",
  "POLICY_DENIED",
  "BUDGET_EXHAUSTED",
  "INVALID_REQUEST",
  "TIMED_OUT",
  "RATE_LIMITED",
  "PROVIDER_UNAVAILABLE",
  "INTERNAL_ERROR",
] as const;

export function remedyForCode(code: string | null | undefined, cwd = process.cwd()): Remedy | null {
  if (!code) return null;
  const remedy = byCode.get(code.toUpperCase()) ?? inferRemedyFromText(code);
  if (!remedy) return null;
  return { ...remedy, command: remedy.command.replaceAll("<cwd>", shellCwd(cwd)) };
}

export function remedyForMessage(message: string, cwd = process.cwd()): Remedy | null {
  const text = message.toLowerCase();
  if (/trust_required|native (?:project )?consent|native acknowledgement|unrestricted native/.test(text)) {
    return remedyForCode("TRUST_REQUIRED", cwd);
  }
  if (/login_required|not logged in|native.?auth|setup-token|keychain-only/.test(text)) {
    return remedyForCode("LOGIN_REQUIRED", cwd);
  }
  if (/containment_unavailable|containment is unavailable|sandbox/.test(text)) {
    return remedyForCode("CONTAINMENT_UNAVAILABLE", cwd);
  }
  if (/unsupported_platform|does not support windows/.test(text)) {
    return remedyForCode("UNSUPPORTED_PLATFORM", cwd);
  }
  if (/budget|quota|cost ceiling/.test(text)) {
    return remedyForCode("BUDGET_EXHAUSTED", cwd);
  }
  if (/rate.?limit|429/.test(text)) {
    return remedyForCode("RATE_LIMITED", cwd);
  }
  return null;
}

export function formatRemedyLines(remedy: Remedy): string[] {
  return [
    `${remedy.title}: ${remedy.explanation}`,
    `Next: ${remedy.command}`,
  ];
}

export function printRemedy(code: string | null | undefined, message?: string, cwd = process.cwd()) {
  const remedy = remedyForCode(code, cwd) ?? (message ? remedyForMessage(message, cwd) : null);
  if (!remedy) return;
  for (const line of formatRemedyLines(remedy)) console.error(line);
}

function inferRemedyFromText(code: string): Remedy | null {
  return remedyForMessage(code);
}

function shellCwd(cwd: string) {
  if (/^[A-Za-z0-9_./:-]+$/.test(cwd)) return cwd;
  return JSON.stringify(cwd);
}
