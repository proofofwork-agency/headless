import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { HeadlessDaemonClient } from "../src/daemon/client";
import { HeadlessDaemon } from "../src/daemon/server";
import { releaseEvidenceArtifact } from "../src/runtime/release-evidence-anchor";
import { getProjectStatePaths } from "../src/runtime/project-state";
import { writeReleaseEvidenceFile } from "../scripts/native-smoke-evidence";
import { HEADLESS_VERSION } from "../src/version";

const fixtures: Array<{ root: string; runtime: string; daemon: HeadlessDaemon }> = [];
const cliPath = new URL("../src/cli.ts", import.meta.url).pathname;

afterEach(async () => {
  while (fixtures.length) {
    const fixture = fixtures.pop()!;
    await fixture.daemon.stop();
    rmSync(fixture.root, { recursive: true, force: true });
    rmSync(fixture.runtime, { recursive: true, force: true });
  }
});

describe("auditor ledger verification", () => {
  test("anchors exact evidence bytes and returns CLI success clean / failure on tampering", async () => {
    const root = mkdtempSync(join(tmpdir(), "headless-ledger-verify-"));
    const runtime = mkdtempSync("/tmp/hlv-");
    const project = join(root, "project");
    const evidencePath = join(project, "docs", "internal", "release-evidence", "test.json");
    const env = { ...process.env, HEADLESS_STATE_HOME: join(root, "state"), HEADLESS_RUNTIME_HOME: runtime };
    mkdirSync(project);
    mkdirSync(dirname(evidencePath), { recursive: true });
    const daemon = new HeadlessDaemon({ projectRoot: project, state: { env } });
    fixtures.push({ root, runtime, daemon });
    await daemon.start();
    const client = new HeadlessDaemonClient({ projectRoot: project, state: { env } });

    const written = writeReleaseEvidenceFile({
      path: evidencePath,
      evidence: { version: 1, releaseGatePassed: true },
      provenance: {
        generatedAt: "2026-07-16T12:00:00.000Z",
        commit: "a".repeat(40),
        platform: "test-x64",
        headlessVersion: HEADLESS_VERSION,
        backendVersions: { codex: "codex test" },
      },
    });
    await client.call("ledger.artifact", releaseEvidenceArtifact({
      relativePath: "docs/internal/release-evidence/test.json",
      sha256: written.sha256,
      provenance: written.document.provenance,
      releaseGatePassed: true,
    }));

    expect(await client.call("ledger.verify", { evidence: true })).toMatchObject({
      ok: true,
      evidence: { checked: 1, matched: 1, mismatched: 0, missing: 0, malformed: 0 },
    });
    const clean = await runCli(["verify", "--evidence", "--json", "--cwd", project], env);
    expect(clean.exitCode).toBe(0);
    expect(JSON.parse(clean.stdout)).toMatchObject({ ok: true, evidence: { matched: 1 } });
    const alias = await runCli(["experimental", "ledger", "verify", "--json", "--cwd", project], env);
    expect(alias.exitCode).toBe(0);
    expect(JSON.parse(alias.stdout)).toMatchObject({ ok: true });

    writeFileSync(evidencePath, `${readFileSync(evidencePath, "utf8").trimEnd()} `, { mode: 0o600 });
    const evidenceTampered = await runCli(["verify", "--evidence", "--json", "--cwd", project], env);
    expect(evidenceTampered.exitCode).toBe(1);
    expect(JSON.parse(evidenceTampered.stdout)).toMatchObject({
      ok: false,
      evidence: { checked: 1, matched: 0, mismatched: 1 },
    });

    const state = getProjectStatePaths(project, { env });
    const lines = readFileSync(state.ledgerPath, "utf8").trimEnd().split("\n");
    const record = JSON.parse(lines.at(-1)!) as { payload: Record<string, unknown> };
    record.payload.tampered = true;
    lines[lines.length - 1] = JSON.stringify(record);
    writeFileSync(state.ledgerPath, `${lines.join("\n")}\n`, { mode: 0o600 });
    const ledgerTampered = await runCli(["verify", "--json", "--cwd", project], env);
    expect(ledgerTampered.exitCode).toBe(1);
    expect(JSON.parse(ledgerTampered.stdout)).toMatchObject({
      ok: false,
      firstBreakAt: { sequence: lines.length, reason: expect.stringContaining("Hash mismatch") },
    });
  }, 30_000);
});

async function runCli(args: string[], env: NodeJS.ProcessEnv) {
  const child = Bun.spawn([process.execPath, cliPath, ...args], {
    env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    Bun.readableStreamToText(child.stdout),
    Bun.readableStreamToText(child.stderr),
    child.exited,
  ]);
  return { stdout, stderr, exitCode };
}
