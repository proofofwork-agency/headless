import type { LedgerVerificationVerdict } from "../../runtime/ledger-v2";
import { resolveCommandAction } from "../argv";
import { CliUsageError, daemonClient, flagArgsBeforeSeparator, getArg, printJson } from "../shared";

export async function runLedgerCommand(args: string[]) {
  const { action } = resolveCommandAction(args);
  const flags = flagArgsBeforeSeparator(args);
  if (action === "verify") {
    await verify(flags);
    return;
  }
  if (action === "repair-tail" && flags.includes("--confirm")) {
    const client = await daemonClient(getArg(flags, "--cwd") || process.cwd(), flags);
    printJson(await client.call("ledger.repairTail", { confirm: true }));
    return;
  }
  throw new CliUsageError("Usage: headless experimental ledger <verify [--evidence] [--json] | repair-tail --confirm> [--cwd dir]");
}

export async function runVerifyCommand(args: string[]) {
  await verify(flagArgsBeforeSeparator(args));
}

async function verify(flags: string[]) {
  const client = await daemonClient(getArg(flags, "--cwd") || process.cwd(), flags);
  const verdict = await client.call<LedgerVerificationVerdict>("ledger.verify", { evidence: flags.includes("--evidence") });
  if (flags.includes("--json")) printJson(verdict);
  else printHumanVerdict(verdict);
  process.exitCode = verdict.ok ? 0 : 1;
}

function printHumanVerdict(verdict: LedgerVerificationVerdict) {
  if (verdict.ok) {
    const head = verdict.head ? `head ${verdict.head.sequence}/${verdict.head.hash}` : "empty ledger";
    console.log(`✓ intact: ${verdict.recordsChecked} records, ${head}, ${verdict.integrity.algorithm}`);
  } else if (verdict.firstBreakAt) {
    console.error(`✗ BREAK at seq ${verdict.firstBreakAt.sequence}: ${verdict.firstBreakAt.reason}`);
  } else {
    console.error(`✗ EVIDENCE: ${verdict.reason ?? "release-evidence verification failed"}`);
  }
  if (verdict.evidence) {
    console.log(
      `evidence: ${verdict.evidence.matched}/${verdict.evidence.checked} matched, `
      + `${verdict.evidence.mismatched} mismatched, ${verdict.evidence.missing} missing, ${verdict.evidence.malformed} malformed`,
    );
  }
  // An intact chain under a weak key is still intact; say how strong the evidence is.
  if (verdict.weakKeys) console.error(`! weak key: ${verdict.weakKeys.reason}`);
}
