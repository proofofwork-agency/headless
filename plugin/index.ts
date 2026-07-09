import { type Plugin, type ToolContext, tool } from "@opencode-ai/plugin";
import {
  appendNote,
  deliberate,
  getReadContext,
  getTaskState,
  headlessRun,
  proposeFinal,
  recordArtifact,
} from "../src/index";

type HeadlessRunArgs = {
  backend: string;
  prompt: string;
  mode?: "read-only" | "write";
  model?: string;
  agent?: string;
  timeoutMs?: number;
};

export const id = "headless";

export const server: Plugin = async () => {
  return {
    tool: {
      headless_run: tool({
        description: "Run a prompt headlessly on opencode, claude-code, codex, or grok-build and return a normalized result.",
        args: {
          backend: tool.schema
            .string()
            .default("opencode")
            .describe("Backend id or alias: opencode, claude-code, claude, codex, codex-cli, grok-build, grok."),
          prompt: tool.schema.string().describe("Prompt or task to execute."),
          mode: tool.schema.enum(["read-only", "write"]).optional().default("read-only"),
          model: tool.schema.string().optional(),
          agent: tool.schema.string().optional(),
          timeoutMs: tool.schema.number().int().positive().optional(),
        },
        async execute(args: HeadlessRunArgs, context) {
          const { result, runId, session } = await headlessRun({
            backend: args.backend,
            prompt: args.prompt,
            cwd: runtimeCwd(context),
            sessionId: runtimeSessionId(context),
            source: "opencode",
            mode: args.mode,
            model: args.model,
            agent: args.agent,
            timeoutMs: args.timeoutMs,
          });

          return {
            title: `headless_run: ${result.backend}`,
            output: JSON.stringify({ sessionId: session.sessionId, runId, result }, null, 2),
            metadata: { sessionId: session.sessionId, runId, result },
          };
        },
      }),
      headless_append_note: tool({
        description: "Append a note to the local Headless session ledger.",
        args: {
          text: tool.schema.string().describe("Note text to record."),
          handlesHandoffId: tool.schema.string().optional(),
        },
        async execute(args: { text: string; handlesHandoffId?: string }, context) {
          const event = appendNote({
            cwd: runtimeCwd(context),
            sessionId: runtimeSessionId(context),
            source: "opencode",
            text: args.text,
            handlesHandoffId: args.handlesHandoffId,
          });
          return toolResult("headless_append_note", event);
        },
      }),
      headless_record_artifact: tool({
        description: "Record a structured artifact in the local Headless session ledger.",
        args: {
          kind: tool.schema.string().describe("Artifact kind, such as test_report, patch_summary, or headless_result."),
          title: tool.schema.string(),
          summary: tool.schema.string(),
          status: tool.schema.enum(["passed", "failed", "blocked", "unknown", "skipped", "timed_out"]).optional().default("unknown"),
          evidence: tool.schema.string().optional().describe("Optional newline-separated evidence."),
        },
        async execute(args: { kind: string; title: string; summary: string; status?: "passed" | "failed" | "blocked" | "unknown" | "skipped" | "timed_out"; evidence?: string }, context) {
          const event = recordArtifact({
            cwd: runtimeCwd(context),
            sessionId: runtimeSessionId(context),
            source: "opencode",
            kind: args.kind,
            title: args.title,
            summary: args.summary,
            status: args.status,
            evidence: splitEvidence(args.evidence),
          });
          return toolResult("headless_record_artifact", event);
        },
      }),
      headless_read_context: tool({
        description: "Read recent Headless ledger context or a summary read model.",
        args: {
          view: tool.schema.enum(["summary", "recent", "raw"]).optional().default("summary"),
          limit: tool.schema.number().int().positive().optional(),
        },
        async execute(args: { view?: "summary" | "recent" | "raw"; limit?: number }, context) {
          const result = getReadContext({
            cwd: runtimeCwd(context),
            sessionId: runtimeSessionId(context),
            source: "opencode",
            view: args.view,
            limit: args.limit,
          });
          return toolResult("headless_read_context", result);
        },
      }),
      headless_task_state: tool({
        description: "Return task lanes, artifacts, finality blockers, and run status derived from the Headless ledger.",
        args: {},
        async execute(_args: never, context) {
          const result = getTaskState({
            cwd: runtimeCwd(context),
            sessionId: runtimeSessionId(context),
            source: "opencode",
          });
          return toolResult("headless_task_state", result);
        },
      }),
      headless_propose_final: tool({
        description: "Record a finality proposal for parent/user acceptance.",
        args: {
          summary: tool.schema.string(),
          evidence: tool.schema.string(),
          remainingRisk: tool.schema.string().optional(),
          handlesHandoffIds: tool.schema.string().optional().describe("Optional newline-separated handoff ids handled by this proposal."),
        },
        async execute(args: { summary: string; evidence: string; remainingRisk?: string; handlesHandoffIds?: string }, context) {
          const event = proposeFinal({
            cwd: runtimeCwd(context),
            sessionId: runtimeSessionId(context),
            source: "opencode",
            summary: args.summary,
            evidence: args.evidence,
            remainingRisk: args.remainingRisk,
            handlesHandoffIds: splitEvidence(args.handlesHandoffIds),
          });
          return toolResult("headless_propose_final", event);
        },
      }),
      headless_deliberate: tool({
        description: "Run bounded fan-out over selected Headless backends and return collected outputs for parent synthesis.",
        args: {
          question: tool.schema.string(),
          backends: tool.schema.string().optional().describe("Comma-separated backend ids or aliases. Defaults to opencode."),
          contextRefs: tool.schema.string().optional().describe("Optional newline-separated file paths or context refs."),
          timeoutMs: tool.schema.number().int().positive().optional(),
          mode: tool.schema.enum(["read-only", "write"]).optional().default("read-only"),
        },
        async execute(args: { question: string; backends?: string; contextRefs?: string; timeoutMs?: number; mode?: "read-only" | "write" }, context) {
          const result = await deliberate({
            cwd: runtimeCwd(context),
            sessionId: runtimeSessionId(context),
            source: "opencode",
            question: args.question,
            backends: splitBackends(args.backends),
            contextRefs: splitEvidence(args.contextRefs),
            timeoutMs: args.timeoutMs,
            mode: args.mode,
          });
          return toolResult("headless_deliberate", {
            sessionId: result.session.sessionId,
            handoff: result.handoff,
            results: result.results,
          });
        },
      }),
    },
  };
};

export default {
  id,
  server,
};

function runtimeCwd(context: ToolContext) {
  return context.directory || context.worktree || process.cwd();
}

function runtimeSessionId(context: ToolContext) {
  return context.sessionID;
}

function splitEvidence(value?: string) {
  if (!value) return undefined;
  const lines = value.split(/\r?\n|,/).map((line) => line.trim()).filter(Boolean);
  return lines.length ? lines : undefined;
}

function splitBackends(value?: string) {
  return splitEvidence(value);
}

function toolResult(title: string, value: unknown) {
  return {
    title,
    output: JSON.stringify(value, null, 2),
    metadata: value,
  };
}
