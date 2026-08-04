#!/usr/bin/env bun
/**
 * Exhaustive CLI verification. Derives the command surface from COMMAND_SPECS so
 * it cannot miss a command. Captures exit code, stdout and stderr SEPARATELY for
 * every invocation and asserts cross-cutting invariants over all of them.
 *
 * Non-destructive: never runs a confirmed mutation, a write-mode run, or a path
 * that spends provider quota. Every invocation gets isolated state/runtime homes.
 *
 * Usage: bun scripts/cli-surface-sweep.ts [repo-path] [label]
 *
 * Not wired into `bun run check`: it spawns ~900 processes and takes minutes.
 * Run it when the CLI surface changes — it has caught defects the unit suite
 * does not reach, including a stack trace from a non-TTY `tui`, a raw ENOENT
 * from a bad --cwd, and three commands rejecting a flag they actually honour.
 */

import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = process.argv[2] ?? new URL("..", import.meta.url).pathname;
const LABEL = process.argv[3] ?? "run";

const CLI = join(ROOT, "src/cli.ts");
const TIMEOUT_MS = 20_000;

const { COMMAND_SPECS, STABLE_COMMAND_NAMES } = await import(join(ROOT, "src/cli/command-specs.ts"));

const stateHome = mkdtempSync(join(tmpdir(), `hx-state-${LABEL}-`));
const runtimeHome = mkdtempSync(join(tmpdir(), `hx-rt-${LABEL}-`));
const project = mkdtempSync(join(tmpdir(), `hx-proj-${LABEL}-`));
const badJson = join(project, "bad.json");
writeFileSync(badJson, "{not json");
const emptyJson = join(project, "empty.json");
writeFileSync(emptyJson, "{}");

type Case = { group: string; kind: string; argv: string[] };
type Result = Case & { code: number | null; stdout: string; stderr: string; ms: number; timedOut: boolean };

const results: Result[] = [];

async function run(c: Case): Promise<Result> {
  const started = Date.now();
  const proc = Bun.spawn(["bun", CLI, ...c.argv], {
    // The disposable project, not ROOT. Cases like `--cwd ""` and the ones that
    // pass no --cwd at all deliberately fall back to process.cwd(), and with
    // ROOT that meant running against this actual checkout: `experimental gate`
    // then does real release-gate work on a real tree and blows the 20s budget,
    // so the sweep reported a hang that only reproduces on a developer machine.
    // CLI is an absolute path, so the spawn does not need ROOT.
    cwd: project,
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
    env: {
      ...process.env,
      NO_COLOR: "1",
      CI: "1",
      HEADLESS_STATE_HOME: stateHome,
      HEADLESS_RUNTIME_HOME: runtimeHome,
    },
  });
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; proc.kill(9); }, TIMEOUT_MS);
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const code = await proc.exited;
  clearTimeout(timer);
  return { ...c, code, stdout, stderr, ms: Date.now() - started, timedOut };
}

// ---------------------------------------------------------------------------
// Case generation: derived from COMMAND_SPECS, not hand-listed.
// ---------------------------------------------------------------------------
const EXPERIMENTAL_ONLY = new Set<string>();
for (const spec of COMMAND_SPECS) {
  if (!("internal" in spec) && !STABLE_COMMAND_NAMES.has(spec.name)) EXPERIMENTAL_ONLY.add(spec.name);
}

// Commands that reach a live agent / spend quota / mutate destructively.
const NEVER_HAPPY_PATH = new Set([
  "exec", "run", "goal", "council", "orchestrate", "launch", "session", "workflow",
  "autonomy", "loop", "candidate", "tui", "pair", "ask", "coop-proof", "gate", "setup",
]);
// Commands whose bare form is a safe read.
const SAFE_BARE = new Set([
  "status", "doctor", "verify", "lead", "daemon", "fleet", "approval", "events",
  "logs", "skill", "skills", "budget", "ledger", "receipt", "project", "mcp", "init",
]);

const cases: Case[] = [];
const add = (group: string, kind: string, argv: string[]) => cases.push({ group, kind, argv });

// Global surface
add("_global", "help", ["--help"]);
add("_global", "version", ["--version"]);
add("_global", "experimental-help", ["experimental", "--help"]);
add("_global", "no-args", []);
add("_global", "unknown-command", ["definitely-not-a-command"]);
add("_global", "unknown-command-json", ["definitely-not-a-command", "--json"]);

for (const spec of COMMAND_SPECS) {
  const name: string = spec.name;
  if ("internal" in spec) continue; // pair/ask/coop-proof are not operator surface
  const ns = EXPERIMENTAL_ONLY.has(name) ? ["experimental"] : [];
  const base = [...ns, name];

  // Every command: help, bare, unknown subcommand, unknown flag, --json parity.
  add(name, "help", [...base, "--help"]);
  add(name, "unknown-sub", [...base, "definitely-not-a-subcommand"]);
  add(name, "unknown-sub-json", [...base, "definitely-not-a-subcommand", "--json"]);
  add(name, "unknown-flag", [...base, "--definitely-unknown-flag"]);
  add(name, "unknown-flag-json", [...base, "--definitely-unknown-flag", "--json"]);

  // The regression that started this: a global flag before the subcommand.
  add(name, "cwd-before-action", [...base, "--cwd", project]);
  add(name, "cwd-empty", [...base, "--cwd", ""]);
  add(name, "cwd-missing-value", [...base, "--cwd"]);
  add(name, "cwd-nonexistent", [...base, "--cwd", "/nonexistent/xyz/abc"]);

  if (SAFE_BARE.has(name) && !NEVER_HAPPY_PATH.has(name)) {
    add(name, "bare", [...base, "--cwd", project]);
    add(name, "bare-json", [...base, "--cwd", project, "--json"]);
  }

  // Value-flag edge cases for every declared value flag.
  for (const flag of ("valueFlags" in spec ? spec.valueFlags : [])) {
    add(name, `valueflag-missing${flag}`, [...base, flag]);
    add(name, `valueflag-negative${flag}`, [...base, flag, "-1"]);
    add(name, `valueflag-flaglike${flag}`, [...base, flag, "--json"]);
  }
}

// Targeted adversarial cases
add("exec", "traversal-session", ["exec", "--session-id", "../../etc/passwd", "hi"]);
add("exec", "huge-timeout", ["exec", "--timeout-ms", "99999999999", "hi"]);
add("exec", "separator-flag-prompt", ["exec", "--cwd", project, "--", "--help"]);
add("exec", "bad-mode", ["exec", "--mode", "bogus", "hi"]);
add("exec", "bad-profile", ["exec", "--profile", "bogus", "hi"]);
add("exec", "bad-backend", ["exec", "--backend", "nope", "hi"]);
add("workflow", "bad-json-file", ["experimental", "workflow", "validate", "--file", badJson, "--cwd", project]);
add("workflow", "empty-json-file", ["experimental", "workflow", "validate", "--file", emptyJson, "--cwd", project]);
add("events", "channel-conflict", ["experimental", "events", "--errors", "--activity", "--cwd", project]);
add("events", "channel-conflict-json", ["experimental", "events", "--errors", "--activity", "--json", "--cwd", project]);
add("collaboration", "negative-sequence", ["experimental", "collaboration", "turns", "--goal-id", "g", "--after-sequence", "-1", "--cwd", project]);
add("budget", "linked-hold-missing", ["experimental", "budget", "linked-hold", "inspect", "--link-id", "a".repeat(64), "--cwd", project]);
add("ledger", "repair-no-confirm", ["experimental", "ledger", "repair-tail", "--cwd", project]);
add("daemon", "reap-no-confirm", ["daemon", "reap", "--cwd", project]);
add("mcp", "cwd-then-host", ["mcp", "--cwd", project, "status", "codex"]);
add("lead", "cwd-then-use", ["lead", "--cwd", project, "use", "codex"]);
add("receipt", "show-missing", ["experimental", "receipt", "show", "no-such-run", "--cwd", project]);

// ---------------------------------------------------------------------------
for (const c of cases) {
  results.push(await run(c));
}

const reportPath = join(tmpdir(), `headless-cli-sweep-${LABEL}.json`);
await Bun.write(reportPath, JSON.stringify({ root: ROOT, results }, null, 2));

// ---------------------------------------------------------------------------
// Invariants
// ---------------------------------------------------------------------------
const STACK = /\s+at\s+\S+\s+\(|^\s+at\s+\/|Bun\.spawn|\.ts:\d+:\d+\)|TypeError:|ReferenceError:|RangeError:|is not a function|Cannot read propert/m;
const SECRET = /sk-[A-Za-z0-9]{16,}|ANTHROPIC_API_KEY=\S|OPENAI_API_KEY=\S|xai-[A-Za-z0-9]{16,}|-----BEGIN/;

const fail = <T,>(list: T[], label: string) => {
  if (list.length) { console.log(`\n### ${label}: ${list.length}`); for (const x of list.slice(0, 25)) console.log("   " + JSON.stringify(x)); }
  return list.length;
};

const timeouts = results.filter((r) => r.timedOut).map((r) => r.argv.join(" "));
const stacks = results.filter((r) => STACK.test(r.stderr + r.stdout))
  .map((r) => ({ cmd: r.argv.join(" "), snippet: (r.stderr + r.stdout).match(STACK)?.[0]?.slice(0, 90) }));
const secrets = results.filter((r) => SECRET.test(r.stderr + r.stdout)).map((r) => r.argv.join(" "));
// macOS /var is a symlink to /private/var, so mkdtemp's path and the path the
// CLI actually prints differ. Compare both spellings or the check never fires.
const leakNeedles = [stateHome, runtimeHome].flatMap((p) => {
  let real = p;
  try { real = realpathSync(p); } catch {}
  return real === p ? [p] : [p, real];
});
// Only on FAILING invocations. `doctor` and `status` report the state directory
// on purpose — that is the diagnostic. An internal path surfacing inside an
// error message is the defect, because the operator cannot act on it and it
// travels into bug reports.
const homeLeaks = results
  .filter((r) => r.code !== 0)
  .filter((r) => leakNeedles.some((needle) => (r.stdout + r.stderr).includes(needle)))
  .map((r) => `${r.argv.join(" ")}  ::  ${((r.stdout + r.stderr).match(/\S*(?:budgets|ledger|\.json|\.sock)\S*/) ?? [""])[0].slice(0, 80)}`);

// A raw Node fs error reaching the operator is a leak of internals either way.
const rawFsErrors = results
  .filter((r) => /\b(ENOENT|EACCES|EPERM|EISDIR|ENOTDIR|EEXIST):/.test(r.stdout + r.stderr))
  .map((r) => `${r.argv.join(" ")}  ::  ${((r.stdout + r.stderr).match(/\b(?:ENOENT|EACCES|EPERM|EISDIR|ENOTDIR|EEXIST):[^\n]*/) ?? [""])[0].slice(0, 90)}`);

// Text/JSON parity: for every failing pair, JSON must classify identically.
const parity: string[] = [];
for (const r of results.filter((x) => x.kind.endsWith("-json"))) {
  const twin = results.find((x) => x.group === r.group && x.kind === r.kind.replace(/-json$/, ""));
  if (!twin) continue;
  // A command whose success output is human text declares no --json, so adding
  // the flag changes WHICH failure occurs. The two runs are then not comparable
  // and a mismatch says nothing about classification.
  if (/Unknown flag for \S+: --json\./.test(r.stdout + r.stderr)) continue;
  if (twin.code !== r.code) parity.push(`${r.argv.join(" ")} :: text exit ${twin.code} vs json exit ${r.code}`);
  else if (r.code !== 0) {
    let parsed: any = null;
    try { parsed = JSON.parse(r.stdout); } catch { parity.push(`${r.argv.join(" ")} :: --json failure is not parseable JSON`); continue; }
    const textInternal = /Internal error/.test(twin.stderr);
    const jsonInternal = parsed?.error?.code === "INTERNAL_ERROR";
    if (textInternal !== jsonInternal) parity.push(`${r.argv.join(" ")} :: text INTERNAL=${textInternal} json INTERNAL=${jsonInternal}`);
  }
}

// A failing invocation should say something actionable on stderr.
const silentFailures = results.filter((r) => r.code !== 0 && !r.timedOut && !r.stderr.trim() && !r.stdout.trim())
  .map((r) => r.argv.join(" "));

console.log(`\n===== ${LABEL} =====`);
console.log(`invocations: ${results.length}   exit0: ${results.filter((r) => r.code === 0).length}   nonzero: ${results.filter((r) => r.code !== 0).length}`);
let bad = 0;
bad += fail(timeouts, "TIMEOUTS / HANGS");
bad += fail(stacks, "STACK TRACE / CRASH LEAKAGE");
bad += fail(secrets, "SECRET LEAKAGE");
bad += fail(homeLeaks, "STATE PATH LEAKED TO OUTPUT");
bad += fail(rawFsErrors, "RAW FILESYSTEM ERROR REACHED THE OPERATOR");
bad += fail(parity, "TEXT/JSON CLASSIFICATION DIVERGENCE");
bad += fail(silentFailures, "FAILED WITH NO MESSAGE");
console.log(bad === 0 ? "\nALL INVARIANTS HELD" : `\nINVARIANT VIOLATIONS: ${bad}`);

for (const dir of [stateHome, runtimeHome, project]) { try { rmSync(dir, { recursive: true, force: true }); } catch {} }
