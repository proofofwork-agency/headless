/**
 * Operator-facing readiness inventory for doctor/setup (golden-path UX).
 * Does not read credential contents — only presence of allowlisted paths.
 */
import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  brokerEnvReadiness,
  type BrokerEnvReadiness,
} from "../runtime/broker-env";
import { CLAUDE_SETUP_TOKEN_REMEDY } from "../runtime/native-auth-capsule";
import { formatRemedyLines, remedyForCode } from "./remedy";

export type BackendReadinessId = "codex" | "opencode" | "claude-code" | "grok-build";

export type BackendReadiness = {
  id: BackendReadinessId;
  binary: string;
  onPath: boolean;
  binaryPath: string | null;
  /** Host login material Headless can import (file presence only). */
  nativeCapsulePresent: boolean;
  nativeCapsulePath: string | null;
  nativeDetail: string;
  remedy: string | null;
};

export type TrustReadiness = {
  trusted: boolean;
  nativeLoginAllowed: boolean;
  nativeDirectUnrestrictedAcknowledged: boolean;
  bypassAllowed: boolean;
  nativeReady: boolean;
};

export type DoctorReport = {
  version: "product-readiness-1";
  bunVersion: string;
  platform: string;
  projectRoot: string;
  projectId: string;
  principal: string;
  stateDir: string;
  trust: TrustReadiness;
  backends: BackendReadiness[];
  brokerEnv: BrokerEnvReadiness[];
  brokerEnvSource: "daemon" | "caller" | "unavailable";
  durableJobs: number;
  recentEvents: number;
  readyForNativeExec: boolean;
  recommendedBackend: BackendReadinessId | null;
  nextActions: Array<{ id: string; command: string; reason: string }>;
  remedies: string[];
};

export const BACKEND_INVENTORY = [
  { id: "codex" as const, binary: "codex" },
  { id: "opencode" as const, binary: "opencode" },
  { id: "claude-code" as const, binary: "claude" },
  { id: "grok-build" as const, binary: "grok" },
];

export function inventoryBackends(options: {
  which?: (name: string) => string | null;
  home?: string;
  platform?: NodeJS.Platform;
} = {}): BackendReadiness[] {
  const which = options.which ?? ((name: string) => Bun.which(name));
  const home = options.home ?? homedir();
  const platform = options.platform ?? process.platform;
  return BACKEND_INVENTORY.map((entry) => {
    const binaryPath = which(entry.binary);
    const onPath = Boolean(binaryPath);
    const capsule = nativeCapsuleStatus(entry.id, home, platform);
    let remedy: string | null = null;
    if (!onPath) {
      remedy = `Install the ${entry.binary} CLI and ensure it is on PATH.`;
    } else if (!capsule.present) {
      remedy = capsule.remedy;
    }
    return {
      id: entry.id,
      binary: entry.binary,
      onPath,
      binaryPath: binaryPath ?? null,
      nativeCapsulePresent: capsule.present,
      nativeCapsulePath: capsule.path,
      nativeDetail: capsule.detail,
      remedy,
    };
  });
}

export function inventoryBrokerEnv(env: NodeJS.ProcessEnv = process.env): BrokerEnvReadiness[] {
  return brokerEnvReadiness(env);
}

export function buildDoctorReport(input: {
  projectRoot: string;
  projectId: string;
  principal: string;
  stateDir: string;
  trust: {
    trusted: boolean;
    nativeLoginAllowed: boolean;
    nativeDirectUnrestrictedAcknowledged: boolean;
    bypassAllowed: boolean;
  };
  durableJobs: number;
  recentEvents: number;
  backends?: BackendReadiness[];
  brokerEnv?: BrokerEnvReadiness[];
  brokerEnvSource?: DoctorReport["brokerEnvSource"];
  which?: (name: string) => string | null;
  home?: string;
}): DoctorReport {
  const backends = input.backends ?? inventoryBackends({ which: input.which, home: input.home });
  const brokerEnv = input.brokerEnv ?? inventoryBrokerEnv();
  const brokerEnvSource = input.brokerEnvSource ?? "caller";
  const nativeReady = input.trust.trusted
    && input.trust.nativeLoginAllowed
    && input.trust.nativeDirectUnrestrictedAcknowledged;
  const usable = backends.filter((b) => b.onPath && b.nativeCapsulePresent);
  const recommendedBackend = usable[0]?.id ?? backends.find((b) => b.onPath)?.id ?? null;
  const cwd = shellCwd(input.projectRoot);
  const nextActions: DoctorReport["nextActions"] = [];
  const remedies: string[] = [];

  if (!nativeReady) {
    const trustRemedy = remedyForCode("TRUST_REQUIRED", input.projectRoot);
    nextActions.push({
      id: "grant-native-trust",
      command: trustRemedy?.command ?? `headless project trust grant --allow-native-direct-unrestricted --cwd ${cwd}`,
      reason: "Native login needs project trust plus unrestricted-egress acknowledgement.",
    });
    if (trustRemedy) remedies.push(...formatRemedyLines(trustRemedy));
  }

  for (const backend of backends) {
    if (backend.remedy) {
      nextActions.push({
        id: `fix-${backend.id}`,
        command: backend.remedy.startsWith("headless") || backend.remedy.startsWith("claude ") || backend.remedy.startsWith("codex ") || backend.remedy.startsWith("opencode ") || backend.remedy.startsWith("grok ")
          ? backend.remedy
          : backend.remedy,
        reason: backend.nativeDetail,
      });
      remedies.push(`${backend.id}: ${backend.remedy}`);
    }
  }

  if (nativeReady && recommendedBackend && usable.length) {
    nextActions.push({
      id: "exec-native",
      command: `headless exec --backend ${recommendedBackend} --auth-mode native-login --profile read-only-native --cwd ${cwd} -- "Explain this repository."`,
      reason: "Project is ready for a contained native-login read-only turn.",
    });
    nextActions.push({
      id: "verify",
      command: `headless verify --cwd ${cwd}`,
      reason: "Verify the tamper-evident ledger after runs.",
    });
  } else if (brokerEnvSource !== "unavailable" && !brokerEnv.some((entry) => entry.present)) {
    nextActions.push({
      id: "broker-keys",
      command: `headless exec --backend ${recommendedBackend ?? "opencode"} --profile broker-readonly --cwd ${cwd} -- "…"`,
      reason: "No broker provider API keys in the environment; broker mode needs daemon-held keys (or finish native trust + capsules).",
    });
  }

  if (nextActions.length === 0) {
    nextActions.push({
      id: "setup",
      command: `headless setup --cwd ${cwd}`,
      reason: "Re-run the golden-path wizard.",
    });
  }

  return {
    version: "product-readiness-1",
    bunVersion: Bun.version,
    platform: process.platform,
    projectRoot: input.projectRoot,
    projectId: input.projectId,
    principal: input.principal,
    stateDir: input.stateDir,
    trust: {
      ...input.trust,
      nativeReady,
    },
    backends,
    brokerEnv,
    brokerEnvSource,
    durableJobs: input.durableJobs,
    recentEvents: input.recentEvents,
    readyForNativeExec: nativeReady && usable.length > 0,
    recommendedBackend,
    nextActions: nextActions.slice(0, 8),
    remedies: [...new Set(remedies)].slice(0, 16),
  };
}

export function printDoctorHuman(report: DoctorReport) {
  console.log("headless doctor — v0.2 daemon and runtime self-check");
  console.log(`Bun runtime: ${report.bunVersion}`);
  console.log(`Platform: ${report.platform}`);
  console.log(`Project: ${report.projectRoot}`);
  console.log(`Project ID: ${report.projectId}`);
  console.log(`Authenticated principal: ${report.principal}`);
  console.log(`External state: ${report.stateDir}`);
  console.log(
    `Trust: ${report.trust.trusted ? "trusted" : "not trusted"}`
    + ` · native ${report.trust.nativeLoginAllowed ? "allowed" : "denied"}`
    + ` · egress ${report.trust.nativeDirectUnrestrictedAcknowledged ? "acked" : "not acked"}`
    + ` · ready ${report.trust.nativeReady ? "yes" : "no"}`,
  );
  console.log("Backends:");
  for (const backend of report.backends) {
    const path = backend.onPath ? "on PATH" : "missing";
    const capsule = backend.nativeCapsulePresent ? "capsule ok" : "capsule missing";
    console.log(`  ${backend.id}: ${path} · ${capsule} — ${backend.nativeDetail}`);
    if (backend.remedy) console.log(`    Next: ${backend.remedy}`);
  }
  const brokerEnvLabel = report.brokerEnvSource === "unavailable"
    ? "connected daemon unavailable"
    : `${report.brokerEnvSource} process`;
  console.log(`Broker env (${brokerEnvLabel}, presence only):`);
  if (report.brokerEnvSource === "unavailable") {
    console.log("  unavailable from the connected daemon; restart it with the current Headless build");
  } else {
    for (const entry of report.brokerEnv) {
      console.log(`  ${entry.variable}: ${entry.present ? "set" : "unset"}`);
    }
  }
  console.log(`Durable jobs: ${report.durableJobs}; recent events: ${report.recentEvents}`);
  console.log(`Ready for native exec: ${report.readyForNativeExec ? "yes" : "no"}`
    + (report.recommendedBackend ? ` · recommended ${report.recommendedBackend}` : ""));
  console.log("Containment defaults to required. Unsafe execution is explicit and never used by autonomy or councils.");
  console.log("Next actions:");
  for (const action of report.nextActions) {
    console.log(`  - ${action.command}`);
    console.log(`    (${action.reason})`);
  }
}

/** Capsule probes keyed by backend id (table dispatch, not kernel branching). */
const NATIVE_CAPSULE_PROBES: Record<
  BackendReadinessId,
  (home: string, platform: NodeJS.Platform) => { present: boolean; path: string; detail: string; remedy: string | null }
> = {
  codex: (home) => filePresence(
    join(home, ".codex", "auth.json"),
    "Codex auth.json",
    "Run `codex login` so ~/.codex/auth.json exists.",
  ),
  opencode: (home) => filePresence(
    join(home, ".local", "share", "opencode", "auth.json"),
    "OpenCode auth.json",
    "Run `opencode auth login` so the OpenCode auth store exists.",
  ),
  "claude-code": (home, platform) => claudeCapsuleStatus(home, platform),
  "grok-build": (home) => filePresence(
    join(home, ".grok", "auth.json"),
    "Grok auth.json",
    "Run `grok login` or `grok login --device-auth` so ~/.grok/auth.json exists.",
  ),
};

function nativeCapsuleStatus(id: BackendReadinessId, home: string, platform: NodeJS.Platform) {
  return NATIVE_CAPSULE_PROBES[id](home, platform);
}

function claudeCapsuleStatus(home: string, platform: NodeJS.Platform) {
  const setupToken = join(home, ".claude", ".headless-setup-token");
  const credentials = join(home, ".claude", ".credentials.json");
  if (regularFile(setupToken)) {
    return { present: true, path: setupToken, detail: "setup-token present", remedy: null as string | null };
  }
  if (platform !== "darwin" && regularFile(credentials)) {
    return { present: true, path: credentials, detail: "credentials.json present", remedy: null };
  }
  if (platform === "darwin") {
    return {
      present: false,
      path: setupToken,
      detail: "macOS Keychain login is not importable; setup-token required",
      remedy: CLAUDE_SETUP_TOKEN_REMEDY,
    };
  }
  return {
    present: false,
    path: credentials,
    detail: "no Claude credentials file",
    remedy: "Run `claude auth login`, or mint a setup-token at ~/.claude/.headless-setup-token.",
  };
}

function filePresence(path: string, label: string, remedy: string) {
  if (regularFile(path)) {
    return { present: true, path, detail: `${label} present`, remedy: null as string | null };
  }
  return { present: false, path, detail: `${label} missing`, remedy };
}

function regularFile(path: string) {
  try {
    return existsSync(path) && statSync(path).isFile();
  } catch {
    return false;
  }
}

function shellCwd(cwd: string) {
  if (/^[A-Za-z0-9_./:-]+$/.test(cwd)) return cwd;
  return JSON.stringify(cwd);
}
