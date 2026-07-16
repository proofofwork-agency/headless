import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ClaudeSessionDriver,
  CodexAppServerSessionDriver,
  CodexExecSessionDriver,
  GrokSessionDriver,
  OpenCodeSessionDriver,
  SessionDriverFactory,
  SessionEventAssembler,
  decideReplayFallback,
  type SessionExecutionRequest,
  type SessionExecutionResult,
  type SessionAuthProbeRequest,
  type SessionAuthProbeResult,
  type SessionExecutor,
  type SessionTransport,
  type SessionTransportOpenRequest,
  type SessionTransportRequest,
  type SessionTransportResult,
} from "../src/runtime/session-drivers";
import { schedulingWindow } from "./support/timing";
import { buildClaudeCommand } from "../src/backends/claude";
import { codexSandbox } from "../src/backends/codex";

describe("session driver selection", () => {
  test("reports native login presence and rejects a missing auth capsule", async () => {
    const missing = new ClaudeSessionDriver({
      executor: new FakeExecutor({
        execute: versionAndHelp,
        probeAuth: async () => ({ available: false, reason: "not logged in" }),
      }),
    });
    const available = new ClaudeSessionDriver({
      executor: new FakeExecutor({
        execute: versionAndHelp,
        probeAuth: async () => ({
          available: true,
          reason: "native login found",
          profileFingerprint: "auth-123",
        }),
      }),
    });

    expect(await missing.probe({ cwd: "/repo" })).toMatchObject({
      ok: false,
      auth: { available: false, reason: "not logged in" },
    });
    expect(await available.probe({ cwd: "/repo" })).toMatchObject({
      ok: true,
      auth: { available: true, profileFingerprint: "auth-123" },
    });
  });

  test("prefers a capability-handshaken Codex app-server and records the decision", async () => {
    const probeTransport = new FakeTransport({
      initialize: [{ result: { capabilities: { experimentalApi: true } } }],
    });
    const executor = new FakeExecutor({
      execute: versionAndHelp,
      open: async () => probeTransport,
    });
    const factory = new SessionDriverFactory({ executor, now: () => 100 });

    const selected = await factory.select("codex", { cwd: "/repo" });

    expect(selected.driver.kind).toBe("codex-app-server");
    expect(selected.decision).toMatchObject({
      backend: "codex",
      selectedKind: "codex-app-server",
      decidedAt: 100,
    });
    expect(selected.decision.probes).toHaveLength(1);
    expect(selected.decision.probes[0].ok).toBe(true);
    expect(probeTransport.closed).toBe(true);
    expect(factory.selectionHistory()).toEqual([selected.decision]);
  });

  test("falls back to codex exec resume when the app-server handshake is unavailable", async () => {
    const executor = new FakeExecutor({
      execute: versionAndHelp,
      open: async () => {
        throw new Error("app-server disabled");
      },
    });
    const factory = new SessionDriverFactory({ executor, now: () => 200 });

    const selected = await factory.select("openai", { cwd: "/repo" });

    expect(selected.driver.kind).toBe("codex-exec-resume");
    expect(
      selected.decision.probes.map((probe) => [probe.kind, probe.ok]),
    ).toEqual([
      ["codex-app-server", false],
      ["codex-exec-resume", true],
    ]);
    expect(selected.decision.reason).toContain("proved unavailable");
  });
});

describe("Codex session drivers", () => {
  test("disables both repository skill roots for app-server and exec-resume", async () => {
    const root = mkdtempSync(join(tmpdir(), "headless-codex-session-skills-"));
    try {
      mkdirSync(join(root, ".git"));
      mkdirSync(join(root, ".agents", "skills", "agents-skill"), { recursive: true });
      mkdirSync(join(root, ".codex", "skills", "codex-skill"), { recursive: true });
      writeFileSync(join(root, ".agents", "skills", "agents-skill", "SKILL.md"), "malicious");
      writeFileSync(join(root, ".codex", "skills", "codex-skill", "SKILL.md"), "malicious");

      const transport = new FakeTransport({
        initialize: [{ result: { capabilities: { threads: true } } }],
        "thread/start": [{ result: { thread: { id: "thread-native" } } }],
      });
      const appExecutor = new FakeExecutor({ execute: versionAndHelp, open: async () => transport });
      const appDriver = new CodexAppServerSessionDriver(appExecutor);
      const appHandle = await appDriver.create({ cwd: root });
      const appArguments = appExecutor.opens[0]?.argv.join("\n") ?? "";
      expect(appArguments).toContain("agents-skill/SKILL.md");
      expect(appArguments).toContain("codex-skill/SKILL.md");
      expect(appArguments).toContain("features.plugins=false");
      expect(appArguments).toContain("features.hooks=false");
      expect(appArguments).toContain("features.multi_agent=false");
      await appDriver.close(appHandle);

      const execExecutor = new FakeExecutor({
        execute: sequenceExecutions([
          jsonl([
            { type: "thread.started", thread_id: "thread-exec" },
            { type: "turn.completed", turn_id: "t1" },
          ]),
          jsonl([
            { type: "turn.completed", thread_id: "thread-exec", turn_id: "t2" },
          ]),
        ]),
      });
      const execDriver = new CodexExecSessionDriver({ executor: execExecutor });
      const execHandle = await execDriver.create({ cwd: root });
      await execDriver.send(execHandle, "first");
      await execDriver.send(execHandle, "resume");
      for (const execution of execExecutor.executions) {
        const argumentsText = execution.argv.join("\n");
        expect(argumentsText).toContain("agents-skill/SKILL.md");
        expect(argumentsText).toContain("codex-skill/SKILL.md");
        expect(argumentsText).toContain("features.plugins=false");
        expect(argumentsText).toContain("features.hooks=false");
        expect(argumentsText).toContain("features.multi_agent=false");
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("uses app-server initialize, thread/start, turn/start, idle cancel, and close", async () => {
    const transport = new FakeTransport({
      initialize: [{ result: { capabilities: { threads: true } } }],
      "thread/start": [{ result: { thread: { id: "thread-native" } } }],
      "turn/start": [
        {
          result: { turn: { id: "turn-native" } },
          events: [
            rpc(
              "turn/completed",
              {
                threadId: "thread-native",
                turn: { id: "turn-native", status: "completed" },
                sequence: 5,
              },
              "complete",
            ),
            rpc(
              "item/agentMessage/delta",
              {
                threadId: "thread-native",
                turnId: "turn-native",
                itemId: "message-1",
                delta: "world",
                sequence: 2,
              },
              "delta-2",
            ),
            rpc(
              "thread/tokenUsage/updated",
              {
                threadId: "thread-native",
                turnId: "turn-native",
                sequence: 4,
                tokenUsage: {
                  total: { inputTokens: 7, outputTokens: 2, totalTokens: 9 },
                },
              },
              "usage",
            ),
            rpc(
              "item/agentMessage/delta",
              {
                threadId: "thread-native",
                turnId: "turn-native",
                itemId: "message-1",
                delta: "hello ",
                sequence: 1,
              },
              "delta-1",
            ),
            rpc(
              "item/agentMessage/delta",
              {
                threadId: "thread-native",
                turnId: "turn-native",
                itemId: "message-1",
                delta: "hello ",
                sequence: 1,
              },
              "delta-1",
            ),
          ],
        },
      ],
      "turn/interrupt": [{ result: {} }],
    });
    const executor = new FakeExecutor({
      execute: versionAndHelp,
      open: async () => transport,
    });
    const driver = new CodexAppServerSessionDriver(executor, {
      createId: ids("local-session", "local-turn"),
      now: clock(1_000),
      platform: "darwin",
    });

    const handle = await driver.create({
      cwd: "/repo",
      mode: "write",
      approvalPolicy: "auto",
    });
    const turn = await driver.send(handle, "implement it");

    expect(turn.status).toBe("completed");
    expect(turn.output).toBe("hello world");
    expect(turn.nativeSessionId).toBe("thread-native");
    expect(turn.nativeTurnId).toBe("turn-native");
    expect(turn.usage).toMatchObject({ input: 7, output: 2, total: 9 });
    expect(turn.events.filter((event) => event.id === "delta-1")).toHaveLength(
      1,
    );
    expect(
      transport.requests.find((request) => request.method === "thread/start")
        ?.params,
    ).toMatchObject({
      cwd: "/repo",
      sandbox: "danger-full-access",
      approvalPolicy: "never",
    });

    await driver.cancel(handle);
    expect(transport.requests.map((request) => request.method)).not.toContain(
      "turn/interrupt",
    );
    await driver.close(handle);
    expect(transport.closed).toBe(true);
    expect((await driver.inspect(handle)).status).toBe("closed");
  });

  test("interrupts an active Codex turn with its provider turn identifier and keeps idle cancel idempotent", async () => {
    const transport = new ActiveCodexTransport();
    const executor = new FakeExecutor({
      execute: versionAndHelp,
      open: async () => transport,
    });
    const driver = new CodexAppServerSessionDriver(executor, {
      createId: ids("local-session", "local-turn"),
    });
    const handle = await driver.create({ cwd: "/repo" });
    const pending = driver.send(handle, "keep working");
    await waitFor(() => transport.requests.some((request) => request.method === "turn/start"));

    await driver.cancel(handle);
    expect(
      transport.requests.find((request) => request.method === "turn/interrupt")
        ?.params,
    ).toEqual({ threadId: "thread-native", turnId: "provider-turn" });
    expect((await pending).status).toBe("cancelled");

    await driver.cancel(handle);
    expect(
      transport.requests.filter((request) => request.method === "turn/interrupt"),
    ).toHaveLength(1);
  });

  test("forwards app-server probe cancellation to the underlying transport", async () => {
    const transport = new AbortableInitializeTransport();
    const executor = new FakeExecutor({
      execute: versionAndHelp,
      open: async () => transport,
    });
    const driver = new CodexAppServerSessionDriver(executor);
    const controller = new AbortController();
    const pending = driver.probe({ cwd: "/repo", signal: controller.signal });
    await waitFor(() => transport.requests.length === 1);

    controller.abort("stop capability probe");
    const probe = await pending;

    expect(transport.requests[0].signal.aborted).toBe(true);
    expect(transport.closed).toBe(true);
    expect(probe.ok).toBe(false);
  });

  test("uses codex exec for the first turn and exec resume for later turns", async () => {
    const executor = new FakeExecutor({
      execute: sequenceExecutions([
        jsonl([
          { type: "thread.started", thread_id: "thread-exec" },
          {
            type: "item.completed",
            item: { id: "a1", type: "agent_message", text: "first" },
          },
          {
            type: "turn.completed",
            turn_id: "t1",
            usage: { input_tokens: 2, output_tokens: 1 },
          },
        ]),
        jsonl([
          {
            type: "item.completed",
            item: { id: "a2", type: "agent_message", text: "second" },
          },
          {
            type: "turn.completed",
            thread_id: "thread-exec",
            turn_id: "t2",
            usage: { input_tokens: 3, output_tokens: 1 },
          },
        ]),
      ]),
    });
    const driver = new CodexExecSessionDriver({
      executor,
      createId: ids("local", "turn-1", "turn-2"),
      platform: "darwin",
    });
    const handle = await driver.create({ cwd: "/repo", mode: "read-only" });

    expect((await driver.send(handle, "first prompt")).output).toBe("first");
    expect((await driver.send(handle, "follow up")).output).toBe("second");

    expect(executor.executions[0].argv.slice(0, 9)).toEqual([
      "codex",
      "exec",
      "--json",
      "--sandbox",
      "danger-full-access",
      "--cd",
      "/repo",
      "--skip-git-repo-check",
      "--ignore-user-config",
    ]);
    expect(executor.executions[0].argv).toContain("--ignore-rules");
    expect(executor.executions[0].argv).toContain("project_doc_max_bytes=0");
    expect(executor.executions[0].stdin).toBe("first prompt\n");
    expect(executor.executions[1].argv.slice(0, 7)).toEqual([
      "codex",
      "exec",
      "resume",
      "thread-exec",
      "--json",
      "--skip-git-repo-check",
      "--ignore-user-config",
    ]);
    expect(executor.executions[1].argv.at(-1)).toBe("-");
  });
});

describe("native command session drivers", () => {
  test("restores a persisted native session and only replays when resume is unavailable", async () => {
    const nativeExecutor = new FakeExecutor({
      execute: sequenceExecutions([
        jsonl([
          {
            type: "assistant",
            session_id: "persisted",
            message: { id: "m1", content: [{ type: "text", text: "resumed" }] },
          },
          { type: "result", session_id: "persisted" },
        ]),
      ]),
    });
    const nativeDriver = new ClaudeSessionDriver({
      executor: nativeExecutor,
      createId: ids("local-native", "native-turn"),
    });
    const native = await nativeDriver.resume({
      cwd: "/repo",
      nativeSessionId: "persisted",
    });
    expect((await nativeDriver.send(native, "continue")).output).toBe(
      "resumed",
    );
    expect(nativeExecutor.executions[0].argv).toContain("--resume");
    expect(
      nativeExecutor.executions[0].argv[
        nativeExecutor.executions[0].argv.indexOf("--resume") + 1
      ],
    ).toBe("persisted");
    expect((await nativeDriver.inspect(native)).recovery.status).toBe(
      "native-resumed",
    );

    const replayExecutor = new FakeExecutor({
      execute: sequenceExecutions([
        jsonl([
          {
            type: "assistant",
            session_id: "fresh-after-loss",
            message: {
              id: "m2",
              content: [{ type: "text", text: "recovered" }],
            },
          },
          { type: "result", session_id: "fresh-after-loss" },
        ]),
      ]),
    });
    const replayDriver = new ClaudeSessionDriver({
      executor: replayExecutor,
      createId: ids("fresh-after-loss", "replay-turn"),
    });
    const replay = await replayDriver.resume({
      cwd: "/repo",
      nativeResumeAvailable: false,
      transcript: [
        { role: "user", content: "prior sk-123456789012345678901234567890" },
      ],
    });
    expect((await replayDriver.send(replay, "new request")).output).toBe(
      "recovered",
    );
    expect(replayExecutor.executions[0].argv).toContain("--session-id");
    expect(replayExecutor.executions[0].stdin).toContain(
      "BOUNDED REDACTED SESSION REPLAY",
    );
    expect(replayExecutor.executions[0].stdin).not.toContain(
      "sk-123456789012345678901234567890",
    );
    expect((await replayDriver.inspect(replay)).recovery.status).toBe(
      "replayed",
    );

    await expect(
      replayDriver.resume({ cwd: "/repo", nativeResumeAvailable: false }),
    ).rejects.toMatchObject({
      code: "NATIVE_SESSION_LOST",
    });
  });

  test("Claude creates a durable id and uses --resume on the second turn", async () => {
    const executor = new FakeExecutor({
      execute: sequenceExecutions([
        jsonl([
          { type: "system", subtype: "init", session_id: "claude-native" },
          {
            type: "assistant",
            session_id: "claude-native",
            message: { id: "m1", content: [{ type: "text", text: "one" }] },
          },
          {
            type: "result",
            session_id: "claude-native",
            usage: { input_tokens: 4, output_tokens: 1 },
          },
        ]),
        jsonl([
          {
            type: "assistant",
            session_id: "claude-native",
            message: { id: "m2", content: [{ type: "text", text: "two" }] },
          },
          { type: "result", session_id: "claude-native" },
        ]),
      ]),
    });
    const driver = new ClaudeSessionDriver({
      executor,
      createId: ids("claude-native", "turn-one", "turn-two"),
    });
    const handle = await driver.create({
      cwd: "/repo",
      approvalPolicy: "bypass",
    });

    expect((await driver.send(handle, "first")).output).toBe("one");
    expect((await driver.send(handle, "second")).output).toBe("two");

    expect(executor.executions[0].argv).toContain("--session-id");
    expect(executor.executions[0].argv).not.toContain(
      "--dangerously-skip-permissions",
    );
    expect(executor.executions[0].argv).toContain("--safe-mode");
    expect(executor.executions[0].argv).toContain("bypassPermissions");
    expect(executor.executions[1].argv).toContain("--resume");
    expect(executor.executions[1].argv).not.toContain("--session-id");
    expect(
      executor.executions[1].argv[
        executor.executions[1].argv.indexOf("--resume") + 1
      ],
    ).toBe("claude-native");
  });

  test("Claude sessions retain one-shot allow and deny tool controls in both modes", async () => {
    for (const mode of ["read-only", "write"] as const) {
      const nativeId = `claude-${mode}`;
      const executor = new FakeExecutor({
        execute: sequenceExecutions([
          jsonl([
            { type: "system", subtype: "init", session_id: nativeId },
            { type: "result", session_id: nativeId },
          ]),
          jsonl([{ type: "result", session_id: nativeId }]),
        ]),
      });
      const driver = new ClaudeSessionDriver({
        executor,
        createId: ids(nativeId, `${nativeId}-turn-1`, `${nativeId}-turn-2`),
      });
      const handle = await driver.create({ cwd: "/repo", mode });
      await driver.send(handle, "first");
      await driver.send(handle, "resume");

      const oneShot = buildClaudeCommand({
        backend: "claude-code",
        prompt: "one-shot",
        mode,
        authMode: "native-login",
      });
      for (const execution of executor.executions) {
        for (const flag of ["--tools", "--allowedTools", "--disallowedTools"]) {
          expect(argumentValue(execution.argv, flag)).toBe(argumentValue(oneShot, flag));
        }
        expect(execution.argv).not.toContain("--bare");
        expect(execution.argv).not.toContain("--no-session-persistence");
      }
      expect(oneShot).toContain("--no-session-persistence");
    }
  });

  test("OpenCode captures the first native session and continues with run --session", async () => {
    const executor = new FakeExecutor({
      execute: sequenceExecutions([
        jsonl([
          {
            type: "session.created",
            sessionID: "oc-native",
            event_id: "oc-session",
          },
          {
            type: "message.part.updated",
            sessionID: "oc-native",
            part: { id: "p1", type: "text", text: "first", time: { end: 1 } },
          },
          { type: "session.idle", sessionID: "oc-native" },
        ]),
        jsonl([
          {
            type: "message.part.updated",
            sessionID: "oc-native",
            part: { id: "p2", type: "text", text: "second", time: { end: 1 } },
          },
          { type: "session.idle", sessionID: "oc-native" },
        ]),
      ]),
    });
    const driver = new OpenCodeSessionDriver({
      executor,
      createId: ids("local", "turn-one", "turn-two"),
    });
    const handle = await driver.create({ cwd: "/repo", agent: "reviewer" });

    await driver.send(handle, "first");
    await driver.send(handle, "second");

    expect(executor.executions[0].argv).not.toContain("--session");
    expect(executor.executions[1].argv.slice(0, 8)).toEqual([
      "opencode",
      "run",
      "--pure",
      "--format",
      "json",
      "--dir",
      "/repo",
      "--session",
    ]);
    expect(executor.executions[1].argv[8]).toBe("oc-native");
    expect(executor.executions[0].argv).toEqual(expect.arrayContaining(["--agent", "reviewer"]));
    expect(executor.executions[1].argv).toEqual(expect.arrayContaining(["--agent", "reviewer"]));
    expect((await driver.inspect(handle)).agent).toBe("reviewer");
  });

  test("OpenCode retries one completed isolated database migration within the same turn", async () => {
    const executor = new FakeExecutor({
      execute: sequenceExecutions([
        openCodeMigrationResult(),
        jsonl([
          { type: "session.created", sessionID: "oc-after-migration", event_id: "oc-session" },
          {
            type: "message.part.updated",
            sessionID: "oc-after-migration",
            part: { id: "p1", type: "text", text: "ready", time: { end: 1 } },
          },
          { type: "session.idle", sessionID: "oc-after-migration" },
        ]),
      ]),
    });
    const driver = new OpenCodeSessionDriver({
      executor,
      createId: ids("local", "turn-one"),
    });
    const handle = await driver.create({ cwd: "/repo" });

    const turn = await driver.send(handle, "first", { timeoutMs: 5_000 });

    expect(turn).toMatchObject({ status: "completed", output: "ready", nativeSessionId: "oc-after-migration" });
    expect(executor.executions).toHaveLength(2);
    expect(executor.executions[1].argv).toEqual(executor.executions[0].argv);
    expect(executor.executions[1].cwd).toBe(executor.executions[0].cwd);
    expect(executor.executions[1].env).toBe(executor.executions[0].env);
    expect(executor.executions[1].signal).toBe(executor.executions[0].signal);
    expect(executor.executions[1].timeoutMs).toBeLessThanOrEqual(executor.executions[0].timeoutMs);
  });

  test("OpenCode never retries a completed migration more than once", async () => {
    const executor = new FakeExecutor({
      execute: sequenceExecutions([openCodeMigrationResult(), openCodeMigrationResult()]),
    });
    const driver = new OpenCodeSessionDriver({
      executor,
      createId: ids("local", "turn-one"),
    });
    const handle = await driver.create({ cwd: "/repo" });

    const turn = await driver.send(handle, "first", { timeoutMs: 5_000 });

    expect(executor.executions).toHaveLength(2);
    expect(turn.status).not.toBe("completed");
  });

  test("OpenCode does not retry migration evidence after the total turn deadline", async () => {
    const executor = new FakeExecutor({
      execute: async () => {
        await Bun.sleep(15);
        return openCodeMigrationResult();
      },
    });
    const driver = new OpenCodeSessionDriver({
      executor,
      createId: ids("local", "turn-one"),
    });
    const handle = await driver.create({ cwd: "/repo" });

    const turn = await driver.send(handle, "first", { timeoutMs: 5 });

    expect(executor.executions).toHaveLength(1);
    expect(executor.executions[0].signal.aborted).toBe(true);
    expect(turn).toMatchObject({ status: "failed", error: { code: "TIMED_OUT" } });
  });

  test("OpenCode does not retry migration markers after timeout or overflow", async () => {
    for (const failure of [
      { field: "timedOut", code: "TIMED_OUT" },
      { field: "overflowed", code: "OUTPUT_OVERFLOW" },
    ] as const) {
      const executor = new FakeExecutor({
        execute: async () => ({ ...openCodeMigrationResult(), [failure.field]: true }),
      });
      const driver = new OpenCodeSessionDriver({
        executor,
        createId: ids("local", `turn-${failure.code}`),
      });
      const handle = await driver.create({ cwd: "/repo" });

      const turn = await driver.send(handle, "first", { timeoutMs: 5_000 });

      expect(executor.executions).toHaveLength(1);
      expect(turn).toMatchObject({ status: "failed", error: { code: failure.code } });
    }
  });

  test("Grok uses structured --resume after capturing its session", async () => {
    const executor = new FakeExecutor({
      execute: sequenceExecutions([
        jsonl([
          {
            type: "session.started",
            session_id: "grok-native",
            event_id: "g-session",
          },
          {
            type: "result",
            session_id: "grok-native",
            turn_id: "g1",
            output: "one",
            success: true,
          },
        ]),
        jsonl([
          {
            type: "result",
            session_id: "grok-native",
            turn_id: "g2",
            output: "two",
            success: true,
          },
        ]),
      ]),
    });
    const driver = new GrokSessionDriver({
      executor,
      createId: ids("local", "turn-one", "turn-two"),
    });
    const handle = await driver.create({ cwd: "/repo", agent: "review" });

    await driver.send(handle, "first");
    await driver.send(handle, "second");

    expect(executor.executions[0].argv).toContain("streaming-json");
    expect(executor.executions[0].argv).toEqual(expect.arrayContaining(["--system-prompt-override", "--tools"]));
    expect(executor.executions[0].argv).toEqual(expect.arrayContaining(["--agent", "review"]));
    expect(executor.executions[1].argv).toContain("--resume");
    expect(
      executor.executions[1].argv[
        executor.executions[1].argv.indexOf("--resume") + 1
      ],
    ).toBe("grok-native");
    expect(executor.executions[1].argv).toEqual(expect.arrayContaining(["--agent", "review"]));
  });

  test("Grok assembles current text/data deltas and end envelopes without retaining thoughts", async () => {
    const executor = new FakeExecutor({
      execute: async () => jsonl([
        { type: "thought", data: "private chain" },
        { type: "text", data: "GROK_" },
        { type: "text", data: "SESSION_OK" },
        { type: "end", stopReason: "EndTurn", sessionId: "grok-current", requestId: "request-1" },
      ]),
    });
    const driver = new GrokSessionDriver({ executor, createId: ids("local", "turn-current") });
    const handle = await driver.create({ cwd: "/repo" });

    const turn = await driver.send(handle, "reply");

    expect(turn).toMatchObject({ status: "completed", output: "GROK_SESSION_OK", nativeSessionId: "grok-current" });
    expect(turn.output).not.toContain("private chain");
  });

  test("Grok named sessions fail capability probing when --agent is unavailable", async () => {
    const driver = new GrokSessionDriver({
      executor: new FakeExecutor({
        execute: (request) => request.argv.includes("--version")
          ? { exitCode: 0, stdout: "grok 1.2.3" }
          : { exitCode: 0, stdout: "--resume --output-format --single --no-subagents --no-memory --disable-web-search --verbatim --system-prompt-override --tools" },
      }),
    });

    await expect(driver.probe({ cwd: "/repo" })).resolves.toMatchObject({
      ok: false,
      reason: expect.stringContaining("--agent"),
    });
  });

  test("rejects unsupported or path-based named agents instead of silently ignoring them", async () => {
    const executor = new FakeExecutor({ execute: versionAndHelp });
    const claude = new ClaudeSessionDriver({ executor });
    const codex = new CodexExecSessionDriver({ executor });
    const opencode = new OpenCodeSessionDriver({ executor });
    const grok = new GrokSessionDriver({ executor });

    await expect(claude.create({ cwd: "/repo", agent: "reviewer" })).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    await expect(codex.create({ cwd: "/repo", agent: "reviewer" })).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    await expect(opencode.create({ cwd: "/repo", agent: "../../agent.ts" })).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    await expect(opencode.create({ cwd: "/repo", agent: "agent.toml" })).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    await expect(grok.create({ cwd: "/repo", agent: "agent.json" })).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    await expect(grok.create({ cwd: "/repo", agent: "custom" })).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    expect(executor.executions).toHaveLength(0);
  });

  test("uses raw JSONL as the canonical event path when parsed events are also present", async () => {
    const delta = { type: "message.delta", item_id: "message", delta: "hi" };
    const executor = new FakeExecutor({
      execute: async () => ({
        exitCode: 0,
        stdout: `${JSON.stringify(delta)}\nmalformed-jsonl`,
        events: [
          delta,
          {
            type: "diagnostic",
            message: "Malformed structured session event.",
          },
        ],
      }),
    });
    const driver = new GrokSessionDriver({
      executor,
      createId: ids("local", "turn"),
    });
    const handle = await driver.create({ cwd: "/repo" });

    const result = await driver.send(handle, "hello");

    expect(result.output).toBe("hi");
    expect(result.malformedEvents).toBe(1);
  });
});

describe("event assembly and recovery", () => {
  test("handles reconnects, malformed input, stable ids, out-of-order deltas, and inferred completion", () => {
    const assembler = new SessionEventAssembler({ backend: "codex" });
    assembler.beginConnection("first");
    assembler.push("not json");
    assembler.push(
      rpc(
        "item/agentMessage/delta",
        {
          threadId: "thread",
          turnId: "turn",
          itemId: "item",
          delta: "B",
          sequence: 2,
        },
        "event-b",
      ),
    );
    assembler.beginConnection("second");
    assembler.push(
      rpc(
        "item/agentMessage/delta",
        {
          threadId: "thread",
          turnId: "turn",
          itemId: "item",
          delta: "A",
          sequence: 1,
        },
        "event-a",
      ),
    );
    assembler.push(
      rpc(
        "item/agentMessage/delta",
        {
          threadId: "thread",
          turnId: "turn",
          itemId: "item",
          delta: "A",
          sequence: 1,
        },
        "event-a",
      ),
    );
    assembler.push(
      rpc(
        "item/agentMessage/delta",
        {
          threadId: "thread",
          turnId: "turn",
          itemId: "item",
          delta: "A",
          sequence: 3,
        },
        "event-c",
      ),
    );

    const result = assembler.finish({ exitCode: 0 });

    expect(result.status).toBe("completed");
    expect(result.inferredCompletion).toBe(true);
    expect(result.output).toBe("ABA");
    expect(result.malformedEvents).toBe(1);
    expect(
      result.events.filter((event) => event.id === "event-a"),
    ).toHaveLength(1);
    expect(
      result.events.some(
        (event) =>
          event.kind === "diagnostic" && event.text?.includes("reconnected"),
      ),
    ).toBe(true);
  });

  test("infers rate limits and preserves retry-after evidence", () => {
    const assembler = new SessionEventAssembler({ backend: "opencode" });
    assembler.push({
      type: "error",
      error: { message: "429 rate limit", retry_after: 3 },
    });
    const result = assembler.finish({ exitCode: 1 });

    expect(result.status).toBe("rate-limited");
    expect(result.rateLimit).toMatchObject({
      limited: true,
      retryAfterMs: 3_000,
    });
  });

  test("retains rate-limit lifecycle evidence under pressure and caps retry-after", () => {
    const assembler = new SessionEventAssembler({
      backend: "grok-build",
      maxEvents: 16,
      maxEventBytes: 16_384,
    });
    for (let index = 0; index < 64; index += 1) {
      assembler.push({
        type: "message.delta",
        event_id: `pressure-${index}`,
        item_id: "message",
        sequence: index,
        delta: "x".repeat(256),
      });
    }
    assembler.push({
      type: "rate_limit",
      event_id: "limited",
      message: "quota reached",
      retry_after_ms: 999_999_999,
    });
    const result = assembler.finish({ exitCode: 1 });

    expect(result.status).toBe("rate-limited");
    expect(result.rateLimit).toMatchObject({
      limited: true,
      retryAfterMs: 86_400_000,
      reason: "quota reached",
    });
    expect(
      result.events.some(
        (event) => event.id === "limited" && event.kind === "rate-limit",
      ),
    ).toBe(true);
    expect(result.events.length).toBeLessThanOrEqual(16);
    expect(result.truncated).toBe(true);
  });

  test("does not globally deduplicate identical text from distinct provider items", () => {
    const assembler = new SessionEventAssembler({ backend: "grok-build" });
    assembler.push({
      type: "assistant",
      event_id: "one",
      item_id: "one",
      text: "same",
    });
    assembler.push({
      type: "assistant",
      event_id: "two",
      item_id: "two",
      text: "same",
    });
    assembler.push({ type: "completed", event_id: "done", success: true });
    const result = assembler.finish({ exitCode: 0 });

    expect(result.status).toBe("completed");
    expect(result.output).toBe("same\nsame");
    expect(result.events.filter((event) => event.kind === "text")).toHaveLength(
      2,
    );
  });

  test("bounds retained events and output while preserving terminal events", () => {
    const assembler = new SessionEventAssembler({
      backend: "grok-build",
      maxEvents: 16,
      maxOutputBytes: 1_024,
    });
    for (let index = 0; index < 40; index += 1) {
      assembler.push({
        type: "message.delta",
        event_id: `delta-${index}`,
        item_id: "message",
        sequence: index,
        delta: "é".repeat(80),
      });
    }
    assembler.push({
      type: "completed",
      event_id: "terminal",
      session_id: "g",
      turn_id: "t",
      success: true,
    });
    const result = assembler.finish({ exitCode: 0 });

    expect(result.events.length).toBeLessThanOrEqual(16);
    expect(result.events.some((event) => event.kind === "completion")).toBe(
      true,
    );
    expect(Buffer.byteLength(result.output)).toBeLessThanOrEqual(1_024);
    expect(result.truncated).toBe(true);
  });

  test("retains terminal completion when the event buffer contains only critical events", () => {
    const assembler = new SessionEventAssembler({
      backend: "grok-build",
      maxEvents: 16,
      maxEventBytes: 16_384,
    });
    for (let index = 0; index < 16; index += 1) {
      assembler.push({
        type: "usage",
        event_id: `usage-${index}`,
        usage: { input_tokens: index + 1, output_tokens: index + 1 },
      });
    }
    assembler.push({
      type: "completed",
      event_id: "terminal-after-critical",
      success: true,
    });

    const result = assembler.finish({ exitCode: 0 });

    expect(result.status).toBe("completed");
    expect(result.events).toHaveLength(16);
    expect(
      result.events.some(
        (event) =>
          event.id === "terminal-after-critical" && event.kind === "completion",
      ),
    ).toBe(true);
    expect(result.truncated).toBe(true);
  });

  test("strictly bounds serialized retained-event bytes while preserving completion", () => {
    const maxEventBytes = 16_384;
    const assembler = new SessionEventAssembler({
      backend: "grok-build",
      maxEvents: 16,
      maxEventBytes,
    });
    for (let index = 0; index < 16; index += 1) {
      assembler.push({
        type: "error",
        event_id: `large-error-${index}`,
        message: `${index}:${"é".repeat(32_768)}`,
      });
    }
    assembler.push({
      type: "completed",
      event_id: "bounded-terminal",
      success: true,
    });

    const result = assembler.finish({ exitCode: 0 });

    expect(
      Buffer.byteLength(JSON.stringify(result.events)),
    ).toBeLessThanOrEqual(maxEventBytes);
    expect(
      result.events.some(
        (event) =>
          event.id === "bounded-terminal" && event.kind === "completion",
      ),
    ).toBe(true);
    expect(result.truncated).toBe(true);
  });

  test("process timeout and overflow evidence override provider completion", () => {
    const timedOut = new SessionEventAssembler({ backend: "grok-build" });
    timedOut.push({
      type: "completed",
      event_id: "completed-before-timeout",
      success: true,
    });
    expect(timedOut.finish({ exitCode: 0, timedOut: true })).toMatchObject({
      status: "failed",
      errorCode: "TIMED_OUT",
      error: "Session command timed out.",
    });

    const overflowed = new SessionEventAssembler({ backend: "grok-build" });
    overflowed.push({
      type: "completed",
      event_id: "completed-before-overflow",
      success: true,
    });
    expect(overflowed.finish({ exitCode: 0, overflowed: true })).toMatchObject({
      status: "failed",
      errorCode: "OUTPUT_OVERFLOW",
      error: "Session command exceeded its output bound.",
      truncated: true,
    });
  });

  test("uses redacted bounded replay only when native resume is unavailable", () => {
    const transcript = [
      {
        role: "user" as const,
        content: "token sk-123456789012345678901234567890",
      },
      { role: "assistant" as const, content: "prior answer" },
    ];
    const native = decideReplayFallback({
      nativeResumeSupported: true,
      nativeSessionId: "native",
      transcript,
    });
    const replay = decideReplayFallback({
      nativeResumeSupported: true,
      nativeResumeAvailable: false,
      transcript,
    });

    expect(native.strategy).toBe("native-resume");
    expect(native.text).toBe("");
    expect(replay.strategy).toBe("replay");
    expect(replay.bytes).toBeLessThanOrEqual(200_000);
    expect(replay.text).not.toContain("sk-123456789012345678901234567890");
    expect(replay.text).toContain("[REDACTED_");
  });

  test("cancels an in-flight injected execution without a real process", async () => {
    const executor = new FakeExecutor({
      execute: async (request) =>
        new Promise((resolve) => {
          request.signal.addEventListener(
            "abort",
            () => resolve({ exitCode: null, signal: "SIGTERM" }),
            { once: true },
          );
        }),
    });
    const driver = new OpenCodeSessionDriver({
      executor,
      createId: ids("local", "turn"),
    });
    const handle = await driver.create({ cwd: "/repo" });
    const pending = driver.send(handle, "wait");
    await waitFor(() => executor.executions.length === 1);

    await expect(
      driver.send(handle, "second overlapping turn"),
    ).rejects.toMatchObject({ code: "SESSION_BUSY" });

    await driver.cancel(handle);
    const result = await pending;

    expect(result.status).toBe("cancelled");
    expect(executor.executions[0].signal.aborted).toBe(true);
  });
});

type FakeExecutorOptions = {
  execute: (
    request: SessionExecutionRequest,
  ) => Promise<SessionExecutionResult> | SessionExecutionResult;
  open?: (
    request: SessionTransportOpenRequest,
  ) => Promise<SessionTransport> | SessionTransport;
  probeAuth?: (
    request: SessionAuthProbeRequest,
  ) => Promise<SessionAuthProbeResult> | SessionAuthProbeResult;
};

class FakeExecutor implements SessionExecutor {
  readonly executions: SessionExecutionRequest[] = [];
  readonly opens: SessionTransportOpenRequest[] = [];

  constructor(private readonly options: FakeExecutorOptions) {}

  execute(request: SessionExecutionRequest) {
    this.executions.push(request);
    return Promise.resolve(this.options.execute(request));
  }

  open(request: SessionTransportOpenRequest) {
    this.opens.push(request);
    if (!this.options.open) throw new Error("persistent transport unavailable");
    return Promise.resolve(this.options.open(request));
  }

  probeAuth(request: SessionAuthProbeRequest) {
    if (!this.options.probeAuth)
      return Promise.resolve({ available: true, reason: null });
    return Promise.resolve(this.options.probeAuth(request));
  }
}

class FakeTransport implements SessionTransport {
  readonly id = "fake-stdio";
  readonly requests: SessionTransportRequest[] = [];
  closed = false;

  constructor(
    private readonly responses: Record<
      string,
      Array<SessionTransportResult | Error>
    >,
  ) {}

  async request(input: SessionTransportRequest) {
    this.requests.push(input);
    const value = this.responses[input.method]?.shift();
    if (value instanceof Error) throw value;
    if (!value) return {};
    responseCallback(input)?.(value.result);
    return structuredClone(value);
  }

  async close() {
    this.closed = true;
  }
}

class ActiveCodexTransport implements SessionTransport {
  readonly id = "active-codex";
  readonly requests: SessionTransportRequest[] = [];

  async request(input: SessionTransportRequest) {
    this.requests.push(input);
    if (input.method === "initialize") return { result: { capabilities: {} } };
    if (input.method === "thread/start") {
      return { result: { thread: { id: "thread-native" } } };
    }
    if (input.method === "turn/interrupt") return { result: {} };
    if (input.method !== "turn/start") return {};
    responseCallback(input)?.({ turn: { id: "provider-turn" } });
    return await new Promise<SessionTransportResult>((_resolve, reject) => {
      input.signal.addEventListener(
        "abort",
        () => reject(new Error("turn request cancelled")),
        { once: true },
      );
    });
  }

  async close() {}
}

class AbortableInitializeTransport implements SessionTransport {
  readonly id = "abortable-initialize";
  readonly requests: SessionTransportRequest[] = [];
  closed = false;

  async request(input: SessionTransportRequest) {
    this.requests.push(input);
    return await new Promise<SessionTransportResult>((_resolve, reject) => {
      const cancelled = () => reject(new Error("initialize cancelled"));
      if (input.signal.aborted) cancelled();
      else input.signal.addEventListener("abort", cancelled, { once: true });
    });
  }

  async close() {
    this.closed = true;
  }
}

function responseCallback(input: SessionTransportRequest) {
  return (input as SessionTransportRequest & { onResponse?: (value: unknown) => void }).onResponse;
}

function argumentValue(argv: string[], flag: string) {
  const index = argv.indexOf(flag);
  return index < 0 ? undefined : argv[index + 1];
}

function versionAndHelp(
  request: SessionExecutionRequest,
): SessionExecutionResult {
  if (request.argv.includes("--version"))
    return { exitCode: 0, stdout: `${request.argv[0]} 1.2.3` };
  return {
    exitCode: 0,
    stdout:
      "--resume --session-id --session --output-format --format --dir --single --json --agent --no-subagents --no-memory --disable-web-search --verbatim --system-prompt-override --tools",
  };
}

function sequenceExecutions(results: SessionExecutionResult[]) {
  return (_request: SessionExecutionRequest) => {
    const result = results.shift();
    if (!result) throw new Error("Unexpected fake execution.");
    return result;
  };
}

function jsonl(events: unknown[]): SessionExecutionResult {
  return {
    exitCode: 0,
    stdout: events.map((event) => JSON.stringify(event)).join("\n"),
  };
}

function openCodeMigrationResult(): SessionExecutionResult {
  return {
    exitCode: 0,
    stdout: "",
    stderr: [
      "Performing one time database migration, may take a few minutes...",
      "sqlite-migration:done",
      "Database migration complete.",
    ].join("\n"),
  };
}

function rpc(method: string, params: Record<string, unknown>, eventId: string) {
  return { jsonrpc: "2.0", method, params, event_id: eventId };
}

function ids(...values: string[]) {
  return () => {
    const value = values.shift();
    if (!value) throw new Error("Deterministic id sequence exhausted.");
    return value;
  };
}

function clock(start: number) {
  let value = start;
  return () => value++;
}

async function waitFor(predicate: () => boolean) {
  const deadline = Date.now() + schedulingWindow(1_000);
  while (!predicate()) {
    if (Date.now() >= deadline)
      throw new Error("Timed out waiting for fake executor.");
    await Bun.sleep(1);
  }
}
