import type { DurableSession, Job } from "../../contracts/durable";
import {
  DEFAULT_RUN_TIMEOUT_MS,
  CliUsageError,
  daemonClient,
  flagArgsBeforeSeparator,
  getArg,
  getApprovalPolicy,
  getAuthMode,
  getPrompt,
  parseBackend,
  parseContainment,
  parseIntegerArg,
  requiredArg,
  waitForJob,
} from "../shared";

const sessionActions = new Set(["send", "resume", "cancel", "status", "result"]);

export async function runSessionCommand(args: string[]) {
  const action = args[1] || "status";
  const flags = flagArgsBeforeSeparator(args);
  const projectRoot = getArg(flags, "--cwd") || process.cwd();
  const client = await daemonClient(projectRoot, flags);
  if (action === "create") {
    const backend = parseBackend(getArg(flags, "--backend") || "opencode");
    const session = await client.call<DurableSession>("session.create", {
      backend,
      model: getArg(flags, "--model"),
      agent: getArg(flags, "--agent"),
      containment: parseContainment(flags),
      authMode: getAuthMode(flags),
      approvalPolicy: getApprovalPolicy(flags),
    });
    console.log(JSON.stringify(session, null, 2));
    return;
  }
  if (!sessionActions.has(action)) {
    throw new CliUsageError("Usage: headless session <create|send|resume|cancel|status|result> [options]");
  }
  const sessionId = requiredArg(flags, "--session-id");
  if (action === "send" || action === "resume") {
    const prompt = getPrompt(["session", ...args.slice(2)]);
    if (!prompt) throw new CliUsageError("A session prompt is required.");
    const timeoutMs = parseIntegerArg(flags, "--timeout-ms") ?? DEFAULT_RUN_TIMEOUT_MS;
    const response = await client.call<{ session: DurableSession; job: Job; replay: { truncated: boolean; bytes: number } }>(
      action === "send" ? "session.send" : "session.resume",
      { sessionId, prompt, timeoutMs },
    );
    const job = await waitForJob(client, response.job, timeoutMs);
    const session = await client.call<DurableSession>("session.status", { sessionId });
    console.log(JSON.stringify({ ...response, session, job, result: job.result }, null, 2));
    return;
  }
  const method = action === "cancel" ? "session.cancel" : action === "result" ? "session.result" : "session.status";
  console.log(JSON.stringify(await client.call(method, { sessionId }), null, 2));
}
