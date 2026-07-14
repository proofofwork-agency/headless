import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IntegrationJournal } from "../src/runtime/integration-journal";
import { ensureProjectStateDirectories, getProjectStatePaths } from "../src/runtime/project-state";

const roots: string[] = [];
afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe("durable integration journal", () => {
  test("persists an immutable intent before tracking applied and completed state", () => {
    const root = mkdtempSync(join(tmpdir(), "headless-integration-journal-"));
    roots.push(root);
    const project = join(root, "project");
    mkdirSync(project);
    const paths = ensureProjectStateDirectories(getProjectStatePaths(project, { env: { HEADLESS_STATE_HOME: join(root, "state") } }));
    const journal = new IntegrationJournal(paths, () => 100);
    const intent = {
      jobId: "job-1",
      sessionId: "session-1",
      principal: "coordinator",
      grantId: null,
      phase: "candidate" as const,
      outcome: "merged_fast_forward" as const,
      baseCommit: "a".repeat(40),
      candidateCommit: "b".repeat(40),
      expectedPrimaryHead: "a".repeat(40),
      targetCommit: "b".repeat(40),
    };
    expect(journal.prepare(intent)).toMatchObject({ state: "prepared", resultingCommit: null });
    expect(journal.listOpen()).toHaveLength(1);
    expect(() => journal.prepare({ ...intent, targetCommit: "c".repeat(40) })).toThrow("different intent");
    expect(journal.markApplied("job-1", "b".repeat(40))).toMatchObject({ state: "applied", appliedAt: 100 });
    expect(journal.markCompleted("job-1", "b".repeat(40))).toMatchObject({ state: "completed", completedAt: 100 });
    expect(journal.listOpen()).toEqual([]);
    expect(statSync(join(journal.directory, "job-1.json")).mode & 0o777).toBe(0o600);
  });

  test("durably closes an intent that never updated primary", () => {
    const root = mkdtempSync(join(tmpdir(), "headless-integration-abandoned-"));
    roots.push(root);
    const project = join(root, "project");
    mkdirSync(project);
    const paths = ensureProjectStateDirectories(getProjectStatePaths(project, { env: { HEADLESS_STATE_HOME: join(root, "state") } }));
    const journal = new IntegrationJournal(paths, () => 200);
    journal.prepare({
      jobId: "job-2",
      sessionId: null,
      principal: "coordinator",
      grantId: null,
      phase: "candidate",
      outcome: "merged_fast_forward",
      baseCommit: "a".repeat(40),
      candidateCommit: "b".repeat(40),
      expectedPrimaryHead: "a".repeat(40),
      targetCommit: "b".repeat(40),
    });
    expect(journal.markAbandoned("job-2", "a".repeat(40))).toMatchObject({ state: "abandoned", completedAt: 200 });
    expect(journal.listOpen()).toEqual([]);
  });
});
