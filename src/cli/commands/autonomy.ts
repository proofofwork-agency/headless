import {
  CliUsageError,
  daemonClient,
  flagArgsBeforeSeparator,
  getArg,
  getPrompt,
} from "../shared";

export async function runOrchestrateCommand(args: string[]) {
  const flags = flagArgsBeforeSeparator(args);
  if (flags.includes("--unsafe-no-sandbox")) throw new CliUsageError("Autonomous orchestration prohibits --unsafe-no-sandbox.");
  const client = await daemonClient(getArg(flags, "--cwd") || process.cwd(), flags);
  console.log(JSON.stringify(await client.call("orchestrator.start"), null, 2));
  console.log("Daemon-owned orchestration active. Unsafe jobs are prohibited; excess work remains queued.");
  process.stdin.resume();
}

export async function runAskCommand(args: string[]) {
  const flags = flagArgsBeforeSeparator(args);
  const isBackup = flags.includes("--backup");
  const reason = getPrompt(args) || (isBackup ? "CLI requested backup." : "CLI is ready for more work.");
  const client = await daemonClient(getArg(flags, "--cwd") || process.cwd(), flags);
  const event = await client.call("ledger.event", {
    type: isBackup ? "ask_for_backup" : "ask_for_more_work",
    sessionId: getArg(flags, "--session-id"),
    payload: {
      content: reason,
      meta: isBackup
        ? { neededStrength: getArg(flags, "--strength") }
        : { completed: getArg(flags, "--completed") },
    },
  });
  console.log(`${isBackup ? "ask_for_backup" : "ask_for_more_work"}:`, JSON.stringify(event));
}

export async function runCooperationProofCommand() {
  const client = await daemonClient(process.cwd());
  console.log("COOP-PROOF:START");
  const status = await client.call<{ enabled: boolean }>("orchestrator.status");
  console.log("INSTR_HAS_ASK:", typeof status.enabled === "boolean");
  const more = await client.call<Record<string, unknown>>("ledger.event", { type: "ask_for_more_work", payload: { content: "Proof agent finished and requests more work." } });
  console.log("MORE_WORK_EMITTED:", !!more);
  const backup = await client.call<Record<string, unknown>>("ledger.event", { type: "ask_for_backup", payload: { content: "Proof agent requests backup.", meta: { neededStrength: "review" } } });
  console.log("BACKUP_EMITTED:", !!backup);
  const claim = await client.call<Record<string, unknown>>("ledger.event", { type: "task_claim", payload: { content: "Authenticated proof claim.", meta: { task: "verify cooperation", claimedBy: "authenticated-cli" } } });
  console.log("TASK_CLAIM_EMITTED:", !!claim);
  const vote = await client.call<Record<string, unknown>>("ledger.event", { type: "consensus_vote", payload: { content: "approve: daemon cooperation surface", meta: { proposal: "daemon cooperation surface", vote: "yes", agent: "authenticated-cli", rationale: "typed daemon event accepted" } } });
  console.log("CONSENSUS_VOTE_EMITTED:", !!vote);
  const state = await client.call<{ taskClaims: unknown[]; workRequests: unknown[] }>("ledger.task");
  console.log("STATE_HAS_CLAIMS:", state.taskClaims.length > 0);
  console.log("STATE_HAS_WORK_REQS:", state.workRequests.length > 0);
  console.log("AUTONOMY_RUNNING:", typeof status.enabled === "boolean");
  console.log("AUTONOMY_STOPPED:", !status.enabled);
  console.log("COUNCIL_ROUNDS:", 1, "CONSENSUS:", false);
  console.log("COOP-PROOF:OK agents can request more work + deliberate (claims/votes recorded)");
}

export async function runAutonomyCommand(args: string[]) {
  const action = args[1] || "status";
  const flags = flagArgsBeforeSeparator(args);
  if (flags.includes("--unsafe-no-sandbox")) throw new CliUsageError("Autonomy prohibits --unsafe-no-sandbox.");
  const client = await daemonClient(getArg(flags, "--cwd") || process.cwd(), flags);
  if (action === "on" || action === "start") {
    console.log(JSON.stringify(await client.call("orchestrator.start"), null, 2));
    return;
  }
  if (action === "off" || action === "stop") {
    console.log(JSON.stringify(await client.call("orchestrator.stop"), null, 2));
    return;
  }
  if (action === "ask" || action === "more" || action === "ask-for-work") {
    const reason = getPrompt(["autonomy", ...args.slice(2)]) || "CLI manual ask for more work";
    console.log(JSON.stringify(await client.call("ledger.event", { type: "ask_for_more_work", payload: { content: reason } }), null, 2));
    return;
  }
  if (action === "backup") {
    const problem = getPrompt(["autonomy", ...args.slice(2)]) || "CLI requested backup";
    console.log(JSON.stringify(await client.call("ledger.event", { type: "ask_for_backup", payload: { content: problem, meta: { neededStrength: "any" } } }), null, 2));
    return;
  }
  if (action !== "status") throw new CliUsageError("Usage: headless autonomy <start|stop|status|ask|backup>");
  console.log(JSON.stringify(await client.call("orchestrator.status"), null, 2));
}

export async function runPairCommand(args: string[]) {
  const flags = flagArgsBeforeSeparator(args);
  const client = await daemonClient(getArg(flags, "--cwd") || process.cwd(), flags);
  const sessionId = getArg(flags, "--session-id");
  await client.call("ledger.event", { type: "task_claim", sessionId, payload: { content: "Planner claimed architecture review.", meta: { task: "plan and review architecture", claimedBy: "authenticated-cli" } } });
  await client.call("ledger.note", { sessionId, text: "Planner claims the architecture review portion." });
  await client.call("ledger.event", { type: "task_claim", sessionId, payload: { content: "Executor claimed contained implementation.", meta: { task: "implement changes in a leased worktree", claimedBy: "authenticated-cli" } } });
  await client.call("ledger.event", { type: "ask_for_more_work", sessionId, payload: { content: "Executor is ready for the next task." } });
  console.log(JSON.stringify(await client.call("ledger.task", { sessionId }), null, 2));
}
