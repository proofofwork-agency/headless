import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeBoundedProbe } from "../src/backends/probe";
import { classifyAdapterFailure } from "../src/backends/result-normalization";
import type { BackendDefinition } from "../src/backends/registry";
import { RunErrorCodeSchema, StructuredErrorSchema } from "../src/contracts/common";
import { SessionSchema } from "../src/contracts/durable";
import { resumableNativeSessionId } from "../src/daemon/run-execution-service";
import { HeadlessError, toHeadlessError, toStructuredError } from "../src/runtime/headless-error";
import { signalProcessTree, terminateProcessTree, type KillableChild } from "../src/runtime/process-tree";
import { positiveTimeout, safeOption, supportedPlatform, UnsupportedPlatformError } from "../src/runtime/validation";
import { schedulingWindow } from "./support/timing";

const temporaryPaths: string[] = [];
const descendantPids: number[] = [];

afterEach(() => {
  for (const pid of descendantPids.splice(0)) {
    try { process.kill(pid, "SIGKILL"); } catch {}
  }
  for (const path of temporaryPaths.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("typed control-plane errors", () => {
  test("exposes only a redacted bounded message and serializable details", () => {
    const details: Record<string, unknown> = {
      token: "sk-1234567890abcdefghijklmnop",
      count: 2n,
    };
    details.self = details;
    const error = new HeadlessError("RATE_LIMITED", "provider token sk-1234567890abcdefghijklmnop was limited", {
      retryable: true,
      details,
    });

    expect(error.code).toBe("RATE_LIMITED");
    expect(error.message).not.toContain("1234567890abcdefghijklmnop");
    expect(error.retryable).toBe(true);
    expect(error.details).toEqual({ token: "[REDACTED_OPENAI_KEY]", count: "2", self: "[CIRCULAR]" });
    expect(StructuredErrorSchema.parse(error.toStructuredError())).toEqual(error.toStructuredError());
  });

  test("converts coded legacy failures but suppresses unclassified raw messages", () => {
    const coded = Object.assign(new Error("Native session expired."), { code: "NATIVE_SESSION_LOST", retryable: true });
    expect(toHeadlessError(coded)).toMatchObject({
      code: "NATIVE_SESSION_LOST",
      safeMessage: "Native session expired.",
      retryable: true,
    });
    expect(toStructuredError(new Error("secret internal path"))).toEqual({
      code: "INTERNAL_ERROR",
      message: "Headless could not complete the request.",
      retryable: false,
    });
  });

  test("publishes the v0.2 fleet error codes", () => {
    for (const code of [
      "NATIVE_AUTH_UNAVAILABLE",
      "NATIVE_SESSION_LOST",
      "APPROVAL_REQUIRED",
      "RATE_LIMITED",
      "QUEUE_CAPACITY_EXCEEDED",
      "DAEMON_ALREADY_RUNNING",
      "DAEMON_SHUTDOWN_INCOMPLETE",
    ]) expect(RunErrorCodeSchema.parse(code)).toBe(code);
  });
});

describe("adapter failure classification", () => {
  test("recognizes native auth, approvals, rate limits, and malformed streams", () => {
    expect(classifyAdapterFailure({
      authMode: "native-login",
      error: "Please log in with the installed CLI.",
      output: "",
      stderr: "",
    })).toEqual({ code: "NATIVE_AUTH_UNAVAILABLE", retryable: false, status: "blocked" });
    expect(classifyAdapterFailure({
      authMode: "native-login",
      error: "Not signed in. Run grok login --device-auth.",
      output: "",
      stderr: "",
    })).toEqual({ code: "NATIVE_AUTH_UNAVAILABLE", retryable: false, status: "blocked" });
    expect(classifyAdapterFailure({
      authMode: "native-login",
      error: "Tool use awaiting approval.",
      output: "",
      stderr: "",
    })).toEqual({ code: "APPROVAL_REQUIRED", retryable: false, status: "blocked" });
    expect(classifyAdapterFailure({
      authMode: "broker",
      error: null,
      output: "",
      stderr: "HTTP 429; retry-after: 30",
    })).toEqual({ code: "RATE_LIMITED", retryable: true, status: "failed" });
    expect(classifyAdapterFailure({
      authMode: "native-login",
      error: "Malformed OpenCode JSONL",
      output: "",
      stderr: "",
      malformedEvents: 1,
    })).toEqual({ code: "PARSE_ERROR", retryable: false, status: "failed" });
  });

  test("does not report broker authentication failures as native login loss", () => {
    expect(classifyAdapterFailure({
      authMode: "broker",
      error: "authentication required",
      output: "",
      stderr: "",
    })).toEqual({ code: "PROCESS_ERROR", retryable: false, status: "failed" });
  });
});

describe("mode-compatible native resume", () => {
  test("never resumes a read-only native thread into a fresh write worktree", () => {
    const session = SessionSchema.parse({
      id: "session-one",
      projectId: "a".repeat(64),
      principal: "owner",
      backend: "fixture",
      model: null,
      agent: null,
      containment: "required",
      authMode: "native-login",
      approvalPolicy: "auto",
      state: "idle",
      nativeSessionId: "native-read-thread",
      replay: false,
      transcriptBytes: 0,
      truncated: false,
      lastJobId: null,
      result: null,
      native: null,
      createdAt: 1,
      updatedAt: 1,
    });
    const resumable = { buildResumeCommand: () => ["fixture", "resume"] } as unknown as BackendDefinition;

    expect(resumableNativeSessionId({ mode: "read-only" }, session, resumable)).toBe("native-read-thread");
    expect(resumableNativeSessionId({ mode: "write" }, session, resumable)).toBeUndefined();
    expect(resumableNativeSessionId({ mode: "read-only" }, { ...session, replay: true }, resumable)).toBeUndefined();
    expect(resumableNativeSessionId({ mode: "read-only" }, session, { ...resumable, buildResumeCommand: undefined })).toBeUndefined();
  });
});

describe("shared control-plane validation", () => {
  test("normalizes safe option arguments and rejects flag/control/byte overflow values", () => {
    expect(safeOption("  provider/model  ", "model", { namespace: "Fixture" })).toBe("provider/model");
    for (const value of ["--help", "line\nbreak", "x".repeat(257), "   "]) {
      expect(() => safeOption(value, "model", { namespace: "Fixture" })).toThrow(HeadlessError);
    }
  });

  test("validates bounded positive timeouts and release platforms", () => {
    expect(positiveTimeout(undefined, { defaultValue: 25, max: 50 })).toBe(25);
    expect(() => positiveTimeout(0)).toThrow("positive safe integer");
    expect(() => positiveTimeout(51, { max: 50 })).toThrow(HeadlessError);
    expect(supportedPlatform("linux")).toBe("linux");
    expect(supportedPlatform("fixture", ["fixture"] as const)).toBe("fixture");
    expect(() => supportedPlatform("win32")).toThrow(UnsupportedPlatformError);
  });
});

describe("bounded probe process trees", () => {
  test("falls back to Bun Subprocess.kill(signal) when group delivery is unavailable", async () => {
    const signals: string[] = [];
    const never = new Promise<number>(() => {});
    const child: KillableChild = {
      pid: 41,
      exitCode: null,
      exited: never,
      kill: (signal) => { signals.push(signal); },
    };
    const groupAttempts: Array<[number, string]> = [];
    const signalGroup = (pid: number, signal: "SIGTERM" | "SIGKILL") => {
      groupAttempts.push([pid, signal]);
      throw new Error("process groups unavailable");
    };

    expect(signalProcessTree(child, "SIGKILL", signalGroup)).toBe("child");
    expect(groupAttempts).toEqual([[-41, "SIGKILL"]]);
    expect(signals).toEqual(["SIGKILL"]);

    signals.length = 0;
    const result = await terminateProcessTree(child, { graceMs: 1, killWaitMs: 1, signalGroup });
    expect(result).toEqual({ term: "child", kill: "child", exited: false });
    expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
  });

  test("caps combined probe output and terminates the producer", async () => {
    const result = await executeBoundedProbe(
      [process.execPath, "-e", 'process.stdout.write("x".repeat(8192)); await Bun.sleep(60000)'],
      { timeoutMs: 2_000, maxOutputBytes: 127 },
      { cwd: process.cwd(), env: process.env },
    );

    expect(result.overflowed).toBe(true);
    expect(result.timedOut).toBe(false);
    expect(Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr)).toBeLessThanOrEqual(127);
  });

  test.skipIf(process.platform !== "darwin" && process.platform !== "linux")(
    "times out a probe and terminates its full descendant process group",
    async () => {
      const root = temporaryDirectory("headless-probe-tree-");
      const marker = join(root, "escaped.txt");
      const pidFile = join(root, "descendant.pid");
      const descendantCode = `await Bun.sleep(3000); await Bun.write(${JSON.stringify(marker)}, "escaped")`;
      const parentCode = [
        `const child = Bun.spawn([${JSON.stringify(process.execPath)}, "-e", ${JSON.stringify(descendantCode)}], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });`,
        `await Bun.write(${JSON.stringify(pidFile)}, String(child.pid));`,
        "await Bun.sleep(60000);",
      ].join("\n");

      const result = await executeBoundedProbe(
        [process.execPath, "-e", parentCode],
        { timeoutMs: 2_000, maxOutputBytes: 1_024 },
        { cwd: root, env: process.env },
      );
      if (existsSync(pidFile)) descendantPids.push(Number(readFileSync(pidFile, "utf8")));
      await Bun.sleep(3_500);

      expect(result.timedOut).toBe(true);
      expect(result.overflowed).toBe(false);
      expect(existsSync(pidFile)).toBe(true);
      expect(existsSync(marker)).toBe(false);
    },
    10_000,
  );

  test.skipIf(process.platform !== "darwin" && process.platform !== "linux")(
    "escalates TERM to KILL for a real process group whose descendants ignore TERM",
    async () => {
      const root = temporaryDirectory("headless-term-kill-tree-");
      const ready = join(root, "descendant.ready");
      const marker = join(root, "escaped.txt");
      const pidFile = join(root, "descendant.pid");
      const descendantCode = [
        "process.on('SIGTERM', () => {});",
        `await Bun.write(${JSON.stringify(ready)}, "ready");`,
        "await Bun.sleep(800);",
        `await Bun.write(${JSON.stringify(marker)}, "escaped");`,
        "await Bun.sleep(60000);",
      ].join("\n");
      const parentCode = [
        "process.on('SIGTERM', () => {});",
        `const child = Bun.spawn([${JSON.stringify(process.execPath)}, "-e", ${JSON.stringify(descendantCode)}], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });`,
        `await Bun.write(${JSON.stringify(pidFile)}, String(child.pid));`,
        "await Bun.sleep(60000);",
      ].join("\n");
      const child = Bun.spawn([process.execPath, "-e", parentCode], {
        cwd: root,
        env: process.env,
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
        detached: true,
      });
      await waitForFile(ready, 2_000);
      descendantPids.push(Number(readFileSync(pidFile, "utf8")));

      const result = await terminateProcessTree(child, { graceMs: 50, killWaitMs: 2_000 });
      await Bun.sleep(900);

      expect(result).toEqual({ term: "group", kill: "group", exited: true });
      expect(existsSync(marker)).toBe(false);
    },
  );

  test.skipIf(process.platform !== "darwin" && process.platform !== "linux")(
    "keeps tracking the process group after its root exits on TERM",
    async () => {
      const root = temporaryDirectory("headless-orphan-term-kill-tree-");
      const ready = join(root, "descendant.ready");
      const marker = join(root, "escaped.txt");
      const pidFile = join(root, "descendant.pid");
      const descendantCode = [
        "process.on('SIGTERM', () => {});",
        `await Bun.write(${JSON.stringify(ready)}, "ready");`,
        "await Bun.sleep(500);",
        `await Bun.write(${JSON.stringify(marker)}, "escaped");`,
        "await Bun.sleep(60000);",
      ].join("\n");
      const parentCode = [
        `const child = Bun.spawn([${JSON.stringify(process.execPath)}, "-e", ${JSON.stringify(descendantCode)}], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });`,
        `await Bun.write(${JSON.stringify(pidFile)}, String(child.pid));`,
        "await Bun.sleep(60000);",
      ].join("\n");
      const child = Bun.spawn([process.execPath, "-e", parentCode], {
        cwd: root,
        env: process.env,
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
        detached: true,
      });
      await waitForFile(ready, 2_000);
      descendantPids.push(Number(readFileSync(pidFile, "utf8")));

      const result = await terminateProcessTree(child, { graceMs: 50, killWaitMs: 2_000 });
      await Bun.sleep(600);

      expect(result).toEqual({ term: "group", kill: "group", exited: true });
      expect(existsSync(marker)).toBe(false);
    },
  );
});

function temporaryDirectory(prefix: string) {
  const path = mkdtempSync(join(tmpdir(), prefix));
  temporaryPaths.push(path);
  return path;
}

async function waitForFile(path: string, timeoutMs: number) {
  const deadline = Date.now() + schedulingWindow(timeoutMs);
  while (!existsSync(path)) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${path}`);
    await Bun.sleep(10);
  }
}
