import { describe, expect, test } from "bun:test";
import {
  SessionDriverError,
  SessionDriverFactory,
  type SessionAuthProbeRequest,
  type SessionExecutionRequest,
  type SessionExecutor,
} from "../src/runtime/session-drivers";

describe("session driver factory hardening", () => {
  test("maps an explicit missing login across every candidate to NATIVE_AUTH_UNAVAILABLE", async () => {
    const factory = new SessionDriverFactory({ executor: new MissingAuthExecutor() });

    try {
      await factory.select("claude-code", { cwd: "/repo" });
      throw new Error("Expected session driver selection to fail.");
    } catch (error) {
      expect(error).toBeInstanceOf(SessionDriverError);
      expect(error).toMatchObject({ code: "NATIVE_AUTH_UNAVAILABLE", retryable: false });
    }
  });

  test("stops selection promptly when its caller aborts a pending probe", async () => {
    const factory = new SessionDriverFactory({ executor: new PendingProbeExecutor() });
    const controller = new AbortController();
    const selection = factory.select("opencode", { cwd: "/repo", signal: controller.signal });

    controller.abort("test cancellation");

    try {
      await selection;
      throw new Error("Expected session driver selection to be cancelled.");
    } catch (error) {
      expect(error).toBeInstanceOf(SessionDriverError);
      expect(error).toMatchObject({ code: "CANCELLED", retryable: false });
    }
  });
});

class MissingAuthExecutor implements SessionExecutor {
  execute(request: SessionExecutionRequest) {
    if (request.argv.includes("--version")) return Promise.resolve({ exitCode: 0, stdout: "claude 1.2.3" });
    return Promise.resolve({ exitCode: 0, stdout: "--resume --session-id --output-format" });
  }

  probeAuth(_request: SessionAuthProbeRequest) {
    return Promise.resolve({ available: false, reason: "native login missing" });
  }
}

class PendingProbeExecutor implements SessionExecutor {
  execute(_request: SessionExecutionRequest) {
    return new Promise<never>(() => undefined);
  }
}
