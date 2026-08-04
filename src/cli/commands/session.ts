import type { DurableSession, Job } from "../../contracts/durable";
import { missingOperandError, resolveCommandAction } from "../argv";
import { renderCommandUsage } from "../command-specs";
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
  printJson,
  requiredArg,
  waitForJob,
} from "../shared";

const sessionActions = new Set(["send", "resume", "cancel", "status", "result"]);

export async function runSessionCommand(args: string[]) {
  const { action, argvWithoutAction } = resolveCommandAction(args, "status");
  const flags = flagArgsBeforeSeparator(args);
  const projectRoot = getArg(flags, "--cwd") || process.cwd();
  const client = await daemonClient(projectRoot, flags, { enableExperimentalSessions: true });
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
    printJson(session);
    return;
  }
  if (!sessionActions.has(action)) {
    throw new CliUsageError(renderCommandUsage("session"));
  }
  const sessionId = requiredArg(flags, "--session-id");
  if (action === "send" || action === "resume") {
    const prompt = getPrompt(argvWithoutAction);
    if (!prompt) throw missingOperandError("session", "prompt", { actionPath: [action] });
    const timeoutMs = parseIntegerArg(flags, "--timeout-ms") ?? DEFAULT_RUN_TIMEOUT_MS;
    const response = await client.call<{ session: DurableSession; job: Job; replay: { truncated: boolean; bytes: number } }>(
      action === "send" ? "session.send" : "session.resume",
      { sessionId, prompt, timeoutMs },
    );
    const job = await waitForJob(client, response.job, timeoutMs);
    const session = await client.call<DurableSession>("session.status", { sessionId });
    printJson({ ...response, session, job, result: job.result });
    process.exitCode = job.result?.status === "succeeded" ? 0 : 1;
    return;
  }
  const method = action === "cancel" ? "session.cancel" : action === "result" ? "session.result" : "session.status";
  printJson(await client.call(method, { sessionId }));
}
