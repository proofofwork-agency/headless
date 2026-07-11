import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DurableSession, Job } from "../src/contracts/durable";
import { HeadlessDaemonClient } from "../src/daemon/client";
import { HeadlessDaemon } from "../src/daemon/server";

const roots: string[] = [];
const daemons: HeadlessDaemon[] = [];
const originalPath = process.env.PATH;
const originalCredentials = {
  OPENAI_API_KEY: process.env.OPENAI_API_KEY,
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
};

afterEach(async () => {
  process.env.PATH = originalPath;
  restore("OPENAI_API_KEY", originalCredentials.OPENAI_API_KEY);
  restore("ANTHROPIC_API_KEY", originalCredentials.ANTHROPIC_API_KEY);
  while (daemons.length) await daemons.pop()!.stop();
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe("built-in backend end-to-end sessions", () => {
  test("runs contained one-shots and replay sessions for OpenCode, Claude, and Codex", async () => {
    const fixture = createFixture();
    installBuiltins(fixture.bin);
    process.env.OPENAI_API_KEY = "host-openai-secret";
    process.env.ANTHROPIC_API_KEY = "host-anthropic-secret";
    const daemon = new HeadlessDaemon({ projectRoot: fixture.project, state: fixture.state, token: "a".repeat(48), principal: "coordinator" });
    daemons.push(daemon);
    await daemon.start();
    const client = new HeadlessDaemonClient({ projectRoot: fixture.project, state: fixture.state, token: "a".repeat(48), timeoutMs: 30_000 });

    for (const backend of [
      { id: "opencode", model: "openai/test-model" },
      { id: "claude-code", model: "claude-test" },
      { id: "codex", model: "gpt-test" },
    ]) {
      const submitted = await client.call<Job>("run.submit", {
        backend: backend.id,
        model: backend.model,
        authMode: "broker",
        prompt: `one-shot ${backend.id}`,
        containment: "required",
        timeoutMs: 10_000,
      });
      const oneShot = await client.call<Job>("run.wait", { jobId: submitted.id, timeoutMs: 15_000 }, 20_000);
      expect(oneShot.state).toBe("succeeded");
      expect(oneShot.result?.output).toBe(`${backend.id}-first`);
      expect(oneShot.result?.containment).toMatchObject({ requirement: "required", enforced: true, credentialsIsolated: true });
      expect(oneShot.result?.output).not.toContain("host-");

      const session = await client.call<DurableSession>("session.create", {
        backend: backend.id,
        model: backend.model,
        authMode: "broker",
        containment: "required",
      });
      const first = await client.call<{ job: Job }>("session.send", { sessionId: session.id, prompt: "first request", timeoutMs: 10_000 });
      const firstResult = await client.call<Job>("run.wait", { jobId: first.job.id, timeoutMs: 15_000 }, 20_000);
      expect(firstResult.result?.output).toBe(`${backend.id}-first`);
      const second = await client.call<{ job: Job; replay: { truncated: boolean } }>("session.resume", {
        sessionId: session.id,
        prompt: "second request",
        timeoutMs: 10_000,
      });
      const resumed = await client.call<Job>("run.wait", { jobId: second.job.id, timeoutMs: 15_000 }, 20_000);
      expect(resumed.state).toBe("succeeded");
      expect(resumed.result?.output).toBe(`${backend.id}-replayed`);
      expect(second.replay.truncated).toBe(false);
      expect((await client.call<DurableSession>("session.status", { sessionId: session.id })).replay).toBe(true);
    }
  }, 90_000);
});

function createFixture() {
  const root = mkdtempSync(join(tmpdir(), "headless-builtins-e2e-"));
  roots.push(root);
  const project = join(root, "project");
  const bin = join(root, "bin");
  const stateHome = join(root, "state");
  mkdirSync(project);
  mkdirSync(bin);
  process.env.PATH = `${bin}:${originalPath}`;
  return { project, bin, state: { env: { ...process.env, HEADLESS_STATE_HOME: stateHome } } };
}

function installBuiltins(bin: string) {
  install(bin, "opencode", `
const args=process.argv.slice(2);
if(args.includes("--version")){console.log("opencode 1.17.17");process.exit(0)}
if(args.includes("--help")){console.log("--pure --format --dir --model --agent");process.exit(0)}
if(Object.values(process.env).some((value)=>value==="host-openai-secret"||value==="host-anthropic-secret")){console.error("host credential exposed");process.exit(9)}
const prompt=args.at(-1)??"";
const text=prompt.includes("opencode-first")?"opencode-replayed":"opencode-first";
console.log(JSON.stringify({type:"text",text,usage:{input_tokens:1,output_tokens:1}}));`);
  install(bin, "claude", `
const args=process.argv.slice(2);
if(args.includes("--version")){console.log("claude 2.1.206");process.exit(0)}
if(args.includes("--help")){console.log("--bare --safe-mode --setting-sources --strict-mcp-config --mcp-config --disable-slash-commands --no-session-persistence --no-chrome --allowedTools --disallowedTools");process.exit(0)}
if(Object.values(process.env).some((value)=>value==="host-openai-secret"||value==="host-anthropic-secret")){console.error("host credential exposed");process.exit(9)}
const prompt=await Bun.stdin.text();
const text=prompt.includes("claude-code-first")?"claude-code-replayed":"claude-code-first";
console.log(JSON.stringify({type:"result",result:text,usage:{input_tokens:1,output_tokens:1}}));`);
  install(bin, "codex", `
const args=process.argv.slice(2);
if(args.includes("--version")){console.log("codex-cli 0.144.1");process.exit(0)}
if(args.includes("--help")){console.log("--ignore-user-config --ignore-rules --ephemeral --strict-config read-only workspace-write");process.exit(0)}
if(Object.values(process.env).some((value)=>value==="host-openai-secret"||value==="host-anthropic-secret")){console.error("host credential exposed");process.exit(9)}
const prompt=await Bun.stdin.text();
const text=prompt.includes("codex-first")?"codex-replayed":"codex-first";
console.log(JSON.stringify({type:"item.completed",item:{type:"agent_message",text},usage:{input_tokens:1,output_tokens:1}}));`);
}

function install(bin: string, name: string, body: string) {
  const path = join(bin, name);
  writeFileSync(path, `#!/usr/bin/env bun\n${body}\n`, { mode: 0o700 });
  chmodSync(path, 0o700);
}

function restore(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
