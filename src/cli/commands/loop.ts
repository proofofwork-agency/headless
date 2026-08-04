import { resolveCommandAction } from "../argv";
import { renderCommandUsage } from "../command-specs";
import { CliUsageError, daemonClient, flagArgsBeforeSeparator, getApprovalPolicy, getArg, getAuthMode, getMode, getPrompt, getRepeatedArgs, parseIntegerArg, requiredArg } from "../shared";

export async function runLoopCommand(args: string[]) {
  const { action, argvWithoutAction } = resolveCommandAction(args, "list");
  const flags = flagArgsBeforeSeparator(args);
  const client = await daemonClient(getArg(flags, "--cwd") || process.cwd(), flags);
  if (action === "list") return print(await client.call("loop.list"));
  if (["status", "pause", "resume", "cancel"].includes(action)) {
    const methods = { status: "loop.status", pause: "loop.pause", resume: "loop.resume", cancel: "loop.cancel" } as const;
    return print(await client.call(methods[action as keyof typeof methods], { loopId: requiredArg(flags, "--loop-id") }));
  }
  if (action === "start") {
    if (!flags.includes("--confirm")) throw new CliUsageError("Loop launch requires explicit --confirm after reviewing finite iteration, deadline, and budget bounds.");
    const file = getArg(flags, "--file");
    const policy = file
      ? JSON.parse(await Bun.file(file).text())
      : flags.includes("--repair") ? repairPolicy(flags) : goalPolicy(argvWithoutAction, flags);
    return print(await client.call("loop.start", { policy }));
  }
  throw new CliUsageError(renderCommandUsage("loop"));
}

/**
 * Gate-driven repair. The checks are the oracle, so the loop keeps iterating
 * until the project itself is green rather than until an agent says it is.
 *
 * Integration stays at "preserve" here: repairs land in an isolated candidate
 * and wait for a human. Auto-integration on green is deliberately reachable
 * only through --file, so it is always a written, reviewed decision.
 */
function repairPolicy(flags: string[]) {
  const checks = getRepeatedArgs(flags, "--check");
  const deadlineMs = parseIntegerArg(flags, "--deadline-ms") ?? 7_200_000;
  const maxIterations = parseIntegerArg(flags, "--max-iterations", 1_000) ?? 5;
  const perCost = Number(getArg(flags, "--per-iteration-cost-usd") ?? "2");
  const totalCost = Number(getArg(flags, "--total-cost-usd") ?? String(perCost * maxIterations));
  if (!Number.isFinite(perCost) || perCost <= 0 || !Number.isFinite(totalCost) || totalCost < perCost) {
    throw new CliUsageError("Loop costs must be positive and aggregate cost must cover one iteration.");
  }
  return {
    target: {
      kind: "repair",
      checks: checks.length ? checks : ["check"],
      mode: getMode(flags) ?? "write",
      ...(getArg(flags, "--backend") ? { backend: getArg(flags, "--backend") } : {}),
      ...(getArg(flags, "--verify-backend") ? { verifyBackend: getArg(flags, "--verify-backend") } : {}),
      ...(getAuthMode(flags) ? { authMode: getAuthMode(flags) } : {}),
      ...(getApprovalPolicy(flags) ? { approvalPolicy: getApprovalPolicy(flags) } : {}),
      ...(getArg(flags, "--model") ? { model: getArg(flags, "--model") } : {}),
      maxRepairNodes: parseIntegerArg(flags, "--max-repair-nodes", 32) ?? 8,
      stagnationLimit: parseIntegerArg(flags, "--stagnation-limit", 16) ?? 2,
      gateTimeoutMs: parseIntegerArg(flags, "--gate-timeout-ms") ?? 600_000,
      stepTimeoutMs: parseIntegerArg(flags, "--step-timeout-ms") ?? 900_000,
    },
    maxIterations,
    deadline: Date.now() + deadlineMs,
    perIteration: { maxCostUsd: perCost, maxRequests: 8 },
    aggregate: { maxCostUsd: totalCost, maxRequests: Math.max(8, maxIterations * 8) },
    backoff: { kind: "exponential", initialMs: 1_000, maxMs: 60_000 },
    success: "target-succeeded",
    terminalFailures: ["blocked", "cancelled", "timed_out", "budget_exhausted"],
    approvalPolicy: "ask",
    integrationPolicy: "preserve",
  };
}

function goalPolicy(argvWithoutAction: string[], flags: string[]) {
  const objective = getPrompt(argvWithoutAction);
  if (!objective) throw new CliUsageError("A loop objective or --file policy is required.");
  const deadlineMs = parseIntegerArg(flags, "--deadline-ms") ?? 7_200_000;
  const maxIterations = parseIntegerArg(flags, "--max-iterations", 1_000) ?? 5;
  const perCost = Number(getArg(flags, "--per-iteration-cost-usd") ?? "1");
  const totalCost = Number(getArg(flags, "--total-cost-usd") ?? String(perCost * maxIterations));
  if (!Number.isFinite(perCost) || perCost <= 0 || !Number.isFinite(totalCost) || totalCost < perCost) throw new CliUsageError("Loop costs must be positive and aggregate cost must cover one iteration.");
  return {
    target: { kind: "goal", objective, mode: getMode(flags) ?? "read-only" }, maxIterations, deadline: Date.now() + deadlineMs,
    perIteration: { maxCostUsd: perCost, maxRequests: 1 }, aggregate: { maxCostUsd: totalCost, maxRequests: maxIterations },
    backoff: { kind: "exponential", initialMs: 1_000, maxMs: 60_000 }, success: "target-succeeded",
    terminalFailures: ["blocked", "cancelled", "timed_out", "budget_exhausted"], approvalPolicy: "ask", integrationPolicy: "preserve",
  };
}
function print(value: unknown) { console.log(JSON.stringify(value, null, 2)); }
