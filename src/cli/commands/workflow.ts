import type { Workflow } from "../../contracts/durable";
import {
  DEFAULT_RUN_TIMEOUT_MS,
  MAX_TIMEOUT_MS,
  CliUsageError,
  daemonClient,
  flagArgsBeforeSeparator,
  getArg,
  getApprovalPolicy,
  getAuthMode,
  parseIntegerArg,
  printJson,
  requiredArg,
} from "../shared";

const workflowActions = new Set(["status", "wait", "pause", "resume", "cancel"]);

export async function runWorkflowCommand(args: string[]) {
  const action = args[1] || "list";
  const flags = flagArgsBeforeSeparator(args);
  const client = await daemonClient(getArg(flags, "--cwd") || process.cwd(), flags);
  if (action === "run") {
    if (flags.includes("--unsafe-no-sandbox")) throw new CliUsageError("Workflows prohibit --unsafe-no-sandbox.");
    const definition = await readWorkflowDefinition(requiredArg(flags, "--file"));
    const workflow = await client.call<Workflow>("workflow.run", {
      ...definition,
      ...(getAuthMode(flags) ? { authMode: getAuthMode(flags) } : {}),
      ...(getApprovalPolicy(flags) ? { approvalPolicy: getApprovalPolicy(flags) } : {}),
    });
    printJson(workflow);
    return;
  }
  if (action === "validate" || action === "draft-create") {
    const definition = await readWorkflowDefinition(requiredArg(flags, "--file"));
    printJson(await client.call(action === "validate" ? "workflow.validate" : "workflow.draft.create", definition));
    return;
  }
  if (action === "draft-list") { printJson(await client.call("workflow.draft.list")); return; }
  if (action === "draft-get" || action === "draft-launch") {
    printJson(await client.call(action === "draft-get" ? "workflow.draft.get" : "workflow.draft.launch", { draftId: requiredArg(flags, "--draft-id") })); return;
  }
  if (action === "list") {
    printJson(await client.call<Workflow[]>("workflow.list"));
    return;
  }
  if (!workflowActions.has(action)) {
    throw new CliUsageError("Usage: headless workflow <run|validate|draft-create|draft-list|draft-get|draft-launch|list|status|wait|pause|resume|cancel> [options]");
  }
  const workflowId = requiredArg(flags, "--workflow-id");
  const method = action === "status" ? "workflow.status" : action === "cancel" ? "workflow.cancel" : action === "pause" ? "workflow.pause" : action === "resume" ? "workflow.resume" : "workflow.wait";
  const timeoutMs = action === "wait" ? parseIntegerArg(flags, "--timeout-ms") ?? DEFAULT_RUN_TIMEOUT_MS : undefined;
  const workflow = await client.call<Workflow>(method, { workflowId, timeoutMs }, timeoutMs ? Math.min(timeoutMs + 5_000, MAX_TIMEOUT_MS) : undefined);
  printJson(workflow);
  if (action === "wait") process.exitCode = workflow.state === "succeeded" ? 0 : 1;
}

async function readWorkflowDefinition(path: string) {
  const file = Bun.file(path);
  if (!await file.exists()) throw new CliUsageError(`Workflow definition does not exist: ${path}`);
  if (file.size > 2_500_000) throw new CliUsageError("Workflow definition exceeds the 2500000-byte CLI limit.");
  try {
    const parsed = JSON.parse(await file.text());
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("root must be an object");
    return parsed as Record<string, unknown>;
  } catch (error) {
    throw new CliUsageError(`Workflow definition is invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}
