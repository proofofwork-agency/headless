import { expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * Release evidence must be able to name the tree it measured.
 *
 * `docs/plan.md` forbids carrying an older pass forward after control-plane,
 * native-auth, session-driver, fleet, TUI or package changes — a rule that can
 * only be applied to an artifact whose provenance records a commit. An artifact
 * without one cannot be checked for staleness, only trusted, and "trust it" is
 * how a stale pass gets carried into a release.
 *
 * The writers already record provenance (`writeReleaseEvidenceFile` always
 * attaches it), so this is not guarding a tooling gap. It guards the artifacts:
 * two of them predate that helper, and without something counting them they stay
 * invisible until someone reads the JSON by hand.
 */
const EVIDENCE_DIRECTORY = join(import.meta.dir, "..", "docs", "internal", "release-evidence");

/**
 * Artifacts written before provenance recording existed. Each must be re-run to
 * leave this list — which is a credentialed operator action, not something CI
 * can do, so they are declared rather than failed. Adding to this list should be
 * hard to do accidentally: a NEW artifact without provenance is a bug in the
 * caller, since every writer attaches it.
 */
const LEGACY_WITHOUT_PROVENANCE: Record<string, string> = {
  "gate-b-mcp-smoke.json":
    "Predates release-evidence provenance. Re-run `bun run smoke:gate-b` to date it; until then its freshness cannot be established.",
  "native-write-smoke.json":
    "Predates release-evidence provenance. Re-run `bun run smoke:native-write` to date it; until then its freshness cannot be established.",
};

function evidenceFiles() {
  return readdirSync(EVIDENCE_DIRECTORY).filter((entry) => entry.endsWith(".json")).sort();
}

test("every release-evidence artifact records the commit it measured, or is a declared legacy artifact", () => {
  const files = evidenceFiles();
  // A directory that reads empty would make every assertion below vacuous.
  expect(files.length, "no release-evidence artifacts were found — the path is wrong, not the evidence").toBeGreaterThan(0);

  const undated: string[] = [];
  for (const file of files) {
    const parsed = JSON.parse(readFileSync(join(EVIDENCE_DIRECTORY, file), "utf8")) as {
      provenance?: { commit?: unknown };
    };
    const commit = parsed.provenance?.commit;
    if (typeof commit === "string" && /^[0-9a-f]{40,64}$/.test(commit)) continue;
    if (file in LEGACY_WITHOUT_PROVENANCE) continue;
    undated.push(file);
  }

  expect(
    undated,
    `release evidence without a provenance commit cannot be checked for staleness:\n${undated.join("\n")}`,
  ).toEqual([]);
});

test("the legacy list names only artifacts that are still undated", () => {
  const files = new Set(evidenceFiles());
  const stale: string[] = [];
  for (const [file, reason] of Object.entries(LEGACY_WITHOUT_PROVENANCE)) {
    expect(reason.length, `${file} must state why it is exempt`).toBeGreaterThan(20);
    if (!files.has(file)) {
      stale.push(`${file} (no such artifact)`);
      continue;
    }
    const parsed = JSON.parse(readFileSync(join(EVIDENCE_DIRECTORY, file), "utf8")) as {
      provenance?: { commit?: unknown };
    };
    const commit = parsed.provenance?.commit;
    // Re-running the smoke dates the artifact. The exemption must then go, or
    // the list becomes a permanent excuse nobody revisits.
    if (typeof commit === "string" && /^[0-9a-f]{40,64}$/.test(commit)) stale.push(`${file} (now dated ${commit.slice(0, 7)})`);
  }
  expect(stale, `these exemptions are obsolete and must be removed:\n${stale.join("\n")}`).toEqual([]);
});
