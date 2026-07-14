import { CliUsageError, daemonClient, flagArgsBeforeSeparator, getArg, getMode, getPrompt, parseIntegerArg, requiredArg } from "../shared";

export async function runLoopCommand(args: string[]) {
  const action = args[1] || "list";
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
    const policy = file ? JSON.parse(await Bun.file(file).text()) : goalPolicy(args, flags);
    return print(await client.call("loop.start", { policy }));
  }
  throw new CliUsageError("Usage: headless loop <start|list|status|pause|resume|cancel> [--confirm] [options]");
}

function goalPolicy(args: string[], flags: string[]) {
  const objective = getPrompt(["loop", ...args.slice(2)]);
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
