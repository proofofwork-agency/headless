import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runReleaseGate } from "../src/runtime/release-gate";

const roots: string[] = [];
afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

const platformTest = process.platform === "darwin" || process.platform === "linux" ? test : test.skip;

describe("release gate containment", () => {
  platformTest("project gate scripts cannot read or mutate sibling host files or use direct egress", async () => {
    const root = mkdtempSync(join(tmpdir(), "headless-gate-containment-"));
    roots.push(root);
    const project = join(root, "project");
    const secret = join(root, "secret.txt");
    const escaped = join(root, "escaped.txt");
    mkdirSync(project);
    await Bun.write(join(project, ".keep"), "project");
    writeFileSync(secret, "gate-secret-value");
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("direct-egress-worked") });
    try {
      const script = [
        `try { console.log('READ=' + await Bun.file(${JSON.stringify(secret)}).text()) } catch { console.log('READ=DENIED') }`,
        `try { await Bun.write(${JSON.stringify(escaped)}, 'escape'); console.log('WRITE=ALLOWED') } catch { console.log('WRITE=DENIED') }`,
        `try { console.log('NET=' + await (await fetch('http://127.0.0.1:${server.port}')).text()) } catch { console.log('NET=DENIED') }`,
      ].join(";");
      const report = await runReleaseGate({
        cwd: project,
        checks: [{ name: "adversarial", command: "bun", args: ["-e", script] }],
        timeoutMs: 10_000,
        recordArtifact: false,
      });

      expect(report.ok).toBe(true);
      expect(report.checks[0]?.containment.enforced).toBe(true);
      expect(report.checks[0]?.output).toContain("READ=DENIED");
      expect(report.checks[0]?.output).toMatch(/WRITE=(?:ALLOWED|DENIED)/);
      expect(report.checks[0]?.output).toContain("NET=DENIED");
      expect(report.checks[0]?.output).not.toContain("gate-secret-value");
      expect(existsSync(escaped)).toBe(false);
    } finally {
      server.stop(true);
    }
  });
});
