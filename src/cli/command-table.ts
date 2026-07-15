import { runAskCommand, runAutonomyCommand, runCooperationProofCommand, runOrchestrateCommand, runPairCommand } from "./commands/autonomy";
import { runApprovalCommand } from "./commands/approval";
import { runCandidateCommand } from "./commands/candidate";
import { runCollaborationCommand } from "./commands/collaboration";
import { runDaemonCommand } from "./commands/daemon";
import { runEventsCommand } from "./commands/events";
import { runExecCommand } from "./commands/exec";
import { runFleetCommand } from "./commands/fleet";
import { runGoalCommand } from "./commands/goal";
import { runLaunchCommand } from "./commands/launch";
import { runDoctorCommand, runInitCommand, runStatusCommand, runTuiCommand } from "./commands/lifecycle";
import { runMcpCommand } from "./commands/mcp";
import { runProjectCommand } from "./commands/project";
import { runCouncilCommand, runGateCommand } from "./commands/quality";
import { runSessionCommand } from "./commands/session";
import { runWorkflowCommand } from "./commands/workflow";
import { COMMAND_SPECS, resolveCommandSpec, type CliCommandName } from "./command-specs";
import { runSkillCommand } from "./commands/skill";
import { runLoopCommand } from "./commands/loop";
import { runLedgerCommand, runVerifyCommand } from "./commands/ledger";
import { runLeadCommand } from "./commands/lead";
import { runBudgetCommand } from "./commands/budget";
import { UNIFIED_COMMAND_REGISTRY } from "../command-registry";

export type CliCommandHandler = (args: string[]) => Promise<void>;

const handlers = {
  exec: runExecCommand,
  daemon: runDaemonCommand,
  project: runProjectCommand,
  fleet: runFleetCommand,
  goal: runGoalCommand,
  collaboration: runCollaborationCommand,
  approval: runApprovalCommand,
  candidate: runCandidateCommand,
  session: runSessionCommand,
  workflow: runWorkflowCommand,
  events: runEventsCommand,
  autonomy: runAutonomyCommand,
  orchestrate: runOrchestrateCommand,
  council: runCouncilCommand,
  gate: runGateCommand,
  init: runInitCommand,
  status: runStatusCommand,
  doctor: runDoctorCommand,
  tui: runTuiCommand,
  pair: runPairCommand,
  mcp: runMcpCommand,
  launch: runLaunchCommand,
  ask: runAskCommand,
  "coop-proof": runCooperationProofCommand,
  skill: runSkillCommand,
  loop: runLoopCommand,
  ledger: runLedgerCommand,
  lead: runLeadCommand,
  budget: runBudgetCommand,
  verify: runVerifyCommand,
} satisfies Record<CliCommandName, CliCommandHandler>;

export const COMMAND_TABLE = new Map(UNIFIED_COMMAND_REGISTRY.cli.map(({ source: spec }) => [spec.name, {
  spec,
  handler: handlers[spec.name],
}] as const));

export function resolveCommand(name: string | undefined) {
  const spec = resolveCommandSpec(name);
  return spec ? COMMAND_TABLE.get(spec.name) : undefined;
}
