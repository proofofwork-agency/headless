import { readFileSync, writeFileSync } from "node:fs";
import type { Receipt } from "../../contracts/receipt";
import { LedgerRecordV2Schema, ledgerIntegrityOptionsFromEnv, type LedgerRecordV2 } from "../../runtime/ledger-v2";
import {
  ExportedReceiptSchema,
  verifyExportedReceipt,
  type ExportedReceipt,
  type ExportedReceiptVerdict,
  type ReceiptVerificationVerdict,
} from "../../runtime/receipt-verify";
import { safeJsonParse } from "../../runtime/safe-json";
import { VALUE_FLAGS } from "../command-specs";
import { CliUsageError, daemonClient, flagArgsBeforeSeparator, getArg, parseIntegerArg, printJson } from "../shared";

const USAGE = "Usage: headless experimental receipt <show <runId> | list [--limit n] | export <runId> [--out file] | "
  + "verify <runId> | verify --file <export.json> [--ledger <ledger.jsonl>] | diff <runIdA> <runIdB>> [--json] [--cwd dir]";

export async function runReceiptCommand(args: string[]) {
  const flags = flagArgsBeforeSeparator(args);
  switch (flags[1]) {
    case "show": return show(flags);
    case "list": return list(flags);
    case "export": return exportReceipt(flags);
    case "verify": return verify(flags);
    case "diff": return diff(flags);
    default: throw new CliUsageError(USAGE);
  }
}

async function show(flags: string[]) {
  const runId = positional(flags, 0);
  const client = await daemonClient(projectCwd(flags), flags);
  const receipt = await client.call<Receipt>("receipt.get", { runId });
  if (flags.includes("--json")) printJson(receipt);
  else printReceipt(receipt);
}

async function list(flags: string[]) {
  const limit = parseIntegerArg(flags, "--limit", 10_000);
  const client = await daemonClient(projectCwd(flags), flags);
  const receipts = await client.call<Receipt[]>("receipt.list", limit ? { limit } : {});
  if (flags.includes("--json")) {
    printJson(receipts);
    return;
  }
  if (receipts.length === 0) console.log("(no receipts)");
  else for (const receipt of receipts) console.log(summaryLine(receipt));
}

async function exportReceipt(flags: string[]) {
  const runId = positional(flags, 0);
  const client = await daemonClient(projectCwd(flags), flags);
  const exported = await client.call<ExportedReceipt>("receipt.export", { runId });
  const serialized = `${JSON.stringify(exported, null, 2)}\n`;
  const out = getArg(flags, "--out");
  if (out) {
    writeFileSync(out, serialized, { mode: 0o600 });
    console.error(`Wrote portable receipt for ${runId} to ${out}`);
  } else {
    process.stdout.write(serialized);
  }
}

async function verify(flags: string[]) {
  const file = getArg(flags, "--file");
  if (file) {
    verifyOffline(flags, file);
    return;
  }
  const runId = positional(flags, 0);
  const client = await daemonClient(projectCwd(flags), flags);
  const verdict = await client.call<ReceiptVerificationVerdict>("receipt.verify", { runId });
  if (flags.includes("--json")) printJson(verdict);
  else printOnlineVerdict(runId, verdict);
  process.exitCode = verdict.ok ? 0 : 1;
}

/** Offline verification of a portable export — no daemon; `--ledger` upgrades it to a full-chain check. */
function verifyOffline(flags: string[], file: string) {
  const exported = ExportedReceiptSchema.parse(safeJsonParse(readFileSync(file, "utf8")));
  const ledgerPath = getArg(flags, "--ledger");
  const verdict = verifyExportedReceipt(
    exported,
    ledgerPath ? { records: parseLedgerFile(ledgerPath), ...ledgerIntegrityOptionsFromEnv() } : {},
  );
  if (flags.includes("--json")) printJson(verdict);
  else printOfflineVerdict(exported.receipt.body.runId, verdict);
  process.exitCode = verdict.ok ? 0 : 1;
}

async function diff(flags: string[]) {
  const runIdA = positional(flags, 0);
  const runIdB = positional(flags, 1);
  const client = await daemonClient(projectCwd(flags), flags);
  const [left, right] = await Promise.all([
    client.call<Receipt>("receipt.get", { runId: runIdA }),
    client.call<Receipt>("receipt.get", { runId: runIdB }),
  ]);
  const changes = diffReceipts(left, right);
  if (flags.includes("--json")) {
    printJson({ a: runIdA, b: runIdB, changes });
    return;
  }
  if (changes.length === 0) console.log(`= ${runIdA} and ${runIdB} match on the compared fields`);
  else for (const change of changes) console.log(`~ ${change.field}: ${render(change.a)} -> ${render(change.b)}`);
}

function printReceipt(receipt: Receipt) {
  const { body, integrity } = receipt;
  const lines = [
    `receipt   ${body.receiptId}`,
    `run       ${body.runId}  (${body.result.status})`,
    `principal ${body.principal}`,
    `backend   ${body.request.backend}  ${body.request.mode}${body.request.model ? `  model=${body.request.model}` : ""}`,
    `authority ${body.authorization.source}${body.authorization.grantId ? `  grant=${body.authorization.grantId}` : ""}  merge=${body.authorization.mergeAllowed}`,
    `contain   ${body.result.containment.mechanism ?? "none"}  network=${body.result.containment.network}  creds-isolated=${body.result.containment.credentialsIsolated}${body.result.containment.unsafe ? "  UNSAFE" : ""}`,
    `cost      ${body.result.cost.amountUsd ?? "n/a"} (${body.result.cost.source})  tokens=${body.result.usage.providerTotal ?? "n/a"}  ${body.result.durationMs}ms`,
    `broker    ${body.brokerLease ? `${body.brokerLease.provider} scope=${body.brokerLease.scopeDigest.slice(0, 12)}…` : "none"}`,
    `gates     ${body.gates.length === 0 ? "none" : body.gates.map((gate) => `${gate.phase}/${gate.name}:${gate.status}`).join(" ")}`,
    `anchor    seq ${integrity.ledgerAnchor.sequence}  ${integrity.ledgerAnchor.hash}`,
    `digest    ${integrity.selfDigest}`,
  ];
  console.log(lines.join("\n"));
}

function summaryLine(receipt: Receipt) {
  const { body } = receipt;
  return `${body.runId}  ${body.result.status.padEnd(9)}  ${body.request.backend}/${body.request.mode}  seq ${receipt.integrity.ledgerAnchor.sequence}  ${body.provenance.endedAt}`;
}

function printOnlineVerdict(runId: string, verdict: ReceiptVerificationVerdict) {
  if (verdict.ok) {
    console.log(`✓ VERIFIED ${runId} (full-chain)`);
    return;
  }
  console.error(`✗ FAILED ${runId}: ${verdict.reason ?? "receipt verification failed"}`);
  if (!verdict.ledger.ok && verdict.ledger.firstBreakAt) {
    console.error(`  ledger break at seq ${verdict.ledger.firstBreakAt.sequence}: ${verdict.ledger.firstBreakAt.reason}`);
  }
  if (!verdict.selfDigest.ok && verdict.selfDigest.failingSection) {
    console.error(`  self-digest mismatch in section: ${verdict.selfDigest.failingSection}`);
  }
}

function printOfflineVerdict(runId: string, verdict: ExportedReceiptVerdict) {
  if (!verdict.ok) {
    console.error(`✗ FAILED ${runId}: ${verdict.reason ?? "exported receipt verification failed"}`);
    return;
  }
  const note = verdict.assurance === "full-chain"
    ? "full-chain"
    : verdict.assurance === "embedded-record"
      ? "embedded-record — offline; run with --ledger for full-chain proof"
      : "structural-only — HMAC record; authenticity needs the live ledger and its key";
  console.log(`✓ VERIFIED ${runId} (${note})`);
}

type ReceiptChange = { field: string; a: unknown; b: unknown };

export function diffReceipts(left: Receipt, right: Receipt): ReceiptChange[] {
  const fields: Array<[string, (receipt: Receipt) => unknown]> = [
    ["backend", (r) => r.body.request.backend],
    ["mode", (r) => r.body.request.mode],
    ["model", (r) => r.body.request.model],
    ["status", (r) => r.body.result.status],
    ["authority.source", (r) => r.body.authorization.source],
    ["cost.amountUsd", (r) => r.body.result.cost.amountUsd],
    ["usage.providerTotal", (r) => r.body.result.usage.providerTotal],
    ["containment.mechanism", (r) => r.body.result.containment.mechanism],
    ["containment.network", (r) => r.body.result.containment.network],
    ["containment.unsafe", (r) => r.body.result.containment.unsafe],
    ["gates", (r) => r.body.gates.length],
    ["exitCode", (r) => r.body.result.exitCode],
    ["prompt.digest", (r) => r.body.request.prompt.digest],
    ["output.digest", (r) => r.body.result.output.digest],
  ];
  const changes: ReceiptChange[] = [];
  for (const [field, get] of fields) {
    const a = get(left);
    const b = get(right);
    if (a !== b) changes.push({ field, a, b });
  }
  return changes;
}

function parseLedgerFile(path: string): LedgerRecordV2[] {
  const records: LedgerRecordV2[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    records.push(LedgerRecordV2Schema.parse(safeJsonParse(line)));
  }
  return records;
}

function projectCwd(flags: string[]) {
  return getArg(flags, "--cwd") || process.cwd();
}

/** The nth positional argument after the `receipt <verb>` prefix, skipping flags and their values. */
function positional(flags: string[], index: number) {
  const positionals: string[] = [];
  for (let i = 2; i < flags.length; i += 1) {
    const token = flags[i]!;
    if (token.startsWith("-")) {
      if (VALUE_FLAGS.has(token)) i += 1;
      continue;
    }
    positionals.push(token);
  }
  const value = positionals[index];
  if (!value) throw new CliUsageError(USAGE);
  return value;
}

function render(value: unknown) {
  return value === null || value === undefined ? "n/a" : String(value);
}
