import { ClaudeSessionDriver } from "./claude";
import { CodexAppServerSessionDriver } from "./codex-app-server";
import { CodexExecSessionDriver } from "./codex-exec";
import type { SessionExecutor } from "./executor";
import { SessionDriverError } from "./errors";
import { GrokSessionDriver } from "./grok";
import { OpenCodeSessionDriver } from "./opencode";
import type {
  SessionBackend,
  SessionDriver,
  SessionDriverKind,
  SessionDriverProbe,
  SessionProbeInput,
} from "./types";

export type SessionDriverSelectionDecision = {
  backend: SessionBackend;
  selectedKind: SessionDriverKind | null;
  reason: string;
  probes: SessionDriverProbe[];
  decidedAt: number;
};

export type SessionDriverSelection = {
  driver: SessionDriver;
  decision: SessionDriverSelectionDecision;
};

export type SessionDriverFactoryOptions = {
  executor: SessionExecutor;
  createId?: () => string;
  now?: () => number;
  platform?: string;
};

export class SessionDriverFactory {
  private readonly candidates: Record<SessionBackend, SessionDriver[]>;
  private readonly decisions: SessionDriverSelectionDecision[] = [];
  private readonly now: () => number;

  constructor(options: SessionDriverFactoryOptions) {
    const driverOptions = { executor: options.executor, createId: options.createId, now: options.now, platform: options.platform };
    this.now = options.now ?? Date.now;
    this.candidates = {
      codex: [
        new CodexAppServerSessionDriver(options.executor, driverOptions),
        new CodexExecSessionDriver(driverOptions),
      ],
      "claude-code": [new ClaudeSessionDriver(driverOptions)],
      opencode: [new OpenCodeSessionDriver(driverOptions)],
      "grok-build": [new GrokSessionDriver(driverOptions)],
    };
  }

  async select(backend: SessionBackend | string, input: SessionProbeInput = {}): Promise<SessionDriverSelection> {
    const normalized = normalizeSessionBackend(backend);
    const probes: SessionDriverProbe[] = [];
    for (const driver of this.candidates[normalized]) {
      throwIfProbeCancelled(input.signal);
      let probe: SessionDriverProbe;
      try {
        probe = await probeWithCancellation(driver, input);
      } catch (error) {
        if (input.signal?.aborted || isCancellation(error)) throw cancelledProbeError();
        probe = {
          ok: false,
          backend: normalized,
          kind: driver.kind,
          version: null,
          capabilities: driver.capabilities,
          auth: { available: null, reason: "Driver probe threw before auth detection.", profileFingerprint: null },
          reason: error instanceof Error ? error.message : String(error),
          evidence: [],
        };
      }
      probes.push(probe);
      throwIfProbeCancelled(input.signal);
      if (!probe.ok) continue;
      const decision = {
        backend: normalized,
        selectedKind: driver.kind,
        reason: probes.length === 1
          ? `Selected preferred ${driver.kind} after a successful capability handshake.`
          : `Selected ${driver.kind} after ${probes.slice(0, -1).map((entry) => entry.kind).join(", ")} proved unavailable.`,
        probes,
        decidedAt: this.now(),
      } satisfies SessionDriverSelectionDecision;
      this.decisions.push(structuredClone(decision));
      return { driver, decision };
    }
    const decision = {
      backend: normalized,
      selectedKind: null,
      reason: `No supported session driver is available for ${normalized}.`,
      probes,
      decidedAt: this.now(),
    } satisfies SessionDriverSelectionDecision;
    this.decisions.push(structuredClone(decision));
    const allAuthMissing = probes.length > 0 && probes.every((probe) => probe.auth.available === false);
    throw new SessionDriverError(
      allAuthMissing ? "NATIVE_AUTH_UNAVAILABLE" : "BACKEND_UNAVAILABLE",
      `${decision.reason} ${probes.map((entry) => `${entry.kind}: ${entry.reason ?? "probe failed"}`).join(" ")}`,
      !allAuthMissing,
    );
  }

  selectionHistory() {
    return structuredClone(this.decisions);
  }
}

async function probeWithCancellation(driver: SessionDriver, input: SessionProbeInput) {
  if (!input.signal) return driver.probe(input);
  throwIfProbeCancelled(input.signal);
  return new Promise<SessionDriverProbe>((resolve, reject) => {
    const cancelled = () => reject(cancelledProbeError());
    input.signal!.addEventListener("abort", cancelled, { once: true });
    void driver.probe(input).then(resolve, reject).finally(() => {
      input.signal!.removeEventListener("abort", cancelled);
    });
  });
}

function throwIfProbeCancelled(signal?: AbortSignal): asserts signal is AbortSignal | undefined {
  if (signal?.aborted) throw cancelledProbeError();
}

function cancelledProbeError() {
  return new SessionDriverError("CANCELLED", "Native session driver selection was cancelled.");
}

function isCancellation(error: unknown) {
  return error instanceof SessionDriverError && error.code === "CANCELLED";
}

export function createSessionDriverFactory(options: SessionDriverFactoryOptions) {
  return new SessionDriverFactory(options);
}

export function normalizeSessionBackend(value: string): SessionBackend {
  const normalized = value.trim().toLowerCase();
  if (normalized === "codex" || normalized === "openai") return "codex";
  if (normalized === "claude" || normalized === "claude-code" || normalized === "anthropic") return "claude-code";
  if (normalized === "opencode" || normalized === "oc") return "opencode";
  if (normalized === "grok" || normalized === "grok-build" || normalized === "xai") return "grok-build";
  throw new SessionDriverError("INVALID_REQUEST", `Unsupported session backend: ${value}`);
}
