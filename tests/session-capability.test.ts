import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Persistent-session availability used to depend on which command happened to
 * start the project daemon: a daemon born without --experimental-sessions
 * refused the whole session namespace before parsing arguments, and told the
 * operator to stop a healthy daemon. That turned `session status` — a read —
 * into process mutation.
 *
 * The flag gates nothing but request dispatch (no credential, socket,
 * containment or storage difference), so invoking the namespace activates it
 * in place. These tests pin that, and pin that activation stays authorized.
 */
const cliPath = new URL("../src/cli.ts", import.meta.url).pathname;
const roots: string[] = [];

afterAll(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function isolatedProject() {
  const state = mkdtempSync(join(tmpdir(), "hl-cap-state-"));
  const runtime = mkdtempSync(join(tmpdir(), "hl-cap-rt-"));
  const project = mkdtempSync(join(tmpdir(), "hl-cap-proj-"));
  roots.push(state, runtime, project);
  return { project, env: { HEADLESS_STATE_HOME: state, HEADLESS_RUNTIME_HOME: runtime } };
}

async function runCli(argv: string[], extraEnv: Record<string, string>) {
  const child = Bun.spawn(["bun", cliPath, ...argv], {
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
    env: { ...process.env, NO_COLOR: "1", ...extraEnv } as Record<string, string>,
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { stdout, stderr, exitCode };
}

describe("persistent sessions activate on a daemon that did not start with them", () => {
  test("the session namespace works against a daemon started by another command", async () => {
    const { project, env } = isolatedProject();
    try {
      // Start the daemon through a command that does not request sessions.
      const started = await runCli(["experimental", "goal", "list", "--cwd", project], env);
      expect(started.exitCode).toBe(0);

      const before = await runCli(["status", "--cwd", project], env);
      expect(JSON.parse(before.stdout).daemon.experimentalSessionsEnabled).toBe(false);

      // Reaches the handler and reports a domain error, rather than refusing
      // the namespace and demanding the operator stop a healthy daemon.
      const session = await runCli(["experimental", "session", "status", "--session-id", "missing", "--cwd", project], env);
      expect(session.stderr + session.stdout).toContain("Unknown session: missing");
      expect(session.stderr).not.toContain("Stop it before using");
      expect(session.stderr).not.toContain("does not enable experimental persistent sessions");

      const after = await runCli(["status", "--cwd", project], env);
      expect(JSON.parse(after.stdout).daemon.experimentalSessionsEnabled).toBe(true);
    } finally {
      await runCli(["daemon", "stop", "--cwd", project], env);
    }
  }, 120_000);

  test("activation is idempotent and does not disturb the running daemon", async () => {
    const { project, env } = isolatedProject();
    try {
      await runCli(["experimental", "goal", "list", "--cwd", project], env);
      const first = await runCli(["experimental", "session", "status", "--session-id", "a", "--cwd", project], env);
      const pidAfterFirst = JSON.parse((await runCli(["status", "--cwd", project], env)).stdout).daemon.runtime.pid;

      const second = await runCli(["experimental", "session", "status", "--session-id", "b", "--cwd", project], env);
      const pidAfterSecond = JSON.parse((await runCli(["status", "--cwd", project], env)).stdout).daemon.runtime.pid;

      expect(first.stderr + first.stdout).toContain("Unknown session: a");
      expect(second.stderr + second.stdout).toContain("Unknown session: b");
      // Same process throughout: activation never restarts or replaces it.
      expect(pidAfterSecond).toBe(pidAfterFirst);
    } finally {
      await runCli(["daemon", "stop", "--cwd", project], env);
    }
  }, 120_000);
});
