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
  requiredArg,
} from "../shared";

const workflowActions = new Set(["status", "wait", "cancel"]);

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
    console.log(JSON.stringify(workflow, null, 2));
    return;
  }
  if (action === "list") {
    console.log(JSON.stringify(await client.call<Workflow[]>("workflow.list"), null, 2));
    return;
  }
  if (!workflowActions.has(action)) {
    throw new CliUsageError("Usage: headless workflow <run|list|status|wait|cancel> [--file workflow.json|--workflow-id id]");
  }
  const workflowId = requiredArg(flags, "--workflow-id");
  const method = action === "status" ? "workflow.status" : action === "cancel" ? "workflow.cancel" : "workflow.wait";
  const timeoutMs = action === "wait" ? parseIntegerArg(flags, "--timeout-ms") ?? DEFAULT_RUN_TIMEOUT_MS : undefined;
  const workflow = await client.call<Workflow>(method, { workflowId, timeoutMs }, timeoutMs ? Math.min(timeoutMs + 5_000, MAX_TIMEOUT_MS) : undefined);
  console.log(JSON.stringify(workflow, null, 2));
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
