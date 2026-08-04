import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CliUsageError } from "../src/cli/argv";
import { parseApprovalCommand } from "../src/cli/commands/approval";
import { parseBudgetCommand } from "../src/cli/commands/budget";
import { parseCandidateCommand } from "../src/cli/commands/candidate";
import { parseCollaborationCommand } from "../src/cli/commands/collaboration";
import { runEventsCommand } from "../src/cli/commands/events";
import { parseFleetCommand } from "../src/cli/commands/fleet";
import { parseGoalCommand } from "../src/cli/commands/goal";
import { runLaunchCommand } from "../src/cli/commands/launch";
import { runMcpCommand } from "../src/cli/commands/mcp";
import { parseProjectCommand } from "../src/cli/commands/project";

/**
 * Every handler used to read its subcommand from a physical index, so a global
 * flag became the action. Only handlers that reach no daemon and spawn no host
 * process are exercised here; the grammar itself is pinned in cli-argv.test.ts.
 */
describe("a global flag before the subcommand is no longer read as the action", () => {
  test("project keeps its nested trust grammar behind --cwd", () => {
    expect(parseProjectCommand(["project", "--cwd", "/repo", "trust", "grant", "--allow-bypass"])).toEqual({
      method: "project.trust.grant",
      params: { nativeLoginAllowed: false, nativeDirectUnrestrictedAcknowledged: false, bypassAllowed: true },
    });
    expect(parseProjectCommand(["project", "--cwd", "/repo", "trust"]).method).toBe("project.trust.status");
  });

  test("goal resolves the action and still reads the objective as the prompt", () => {
    // args.slice(2) previously handed getPrompt the --cwd value AND the action,
    // so this reported "Unexpected extra prompt arguments" instead of running.
    expect(parseGoalCommand(["goal", "--cwd", "/repo", "start", "Ship it"])).toMatchObject({
      action: "start",
      method: "goal.start",
      params: { objective: "Ship it" },
    });
    expect(parseGoalCommand(["goal", "--cwd", "/repo"]).method).toBe("goal.list");
    expect(parseGoalCommand(["goal", "--cwd", "/repo", "send", "--goal-id", "g1", "Revise."]).params)
      .toEqual({ goalId: "g1", text: "Revise." });
  });

  test("fleet resolves its two-level namespace behind --cwd", async () => {
    expect(await parseFleetCommand(["fleet", "--cwd", "/repo", "profile", "list"]))
      .toEqual({ method: "fleet.profile.list", params: {} });
    expect(await parseFleetCommand(["fleet", "--cwd", "/repo"]))
      .toEqual({ method: "fleet.health", params: {} });
    expect(await parseFleetCommand(["fleet", "--cwd", "/repo", "profile", "get", "--profile-id", "p1"]))
      .toEqual({ method: "fleet.profile.get", params: { profileId: "p1" } });
  });

  test("collaboration, approval, and candidate resolve behind --cwd", () => {
    expect(parseCollaborationCommand(["collaboration", "--cwd", "/repo", "messages", "--goal-id", "g1"]).method)
      .toBe("collaboration.messages");
    expect(parseApprovalCommand(["approval", "--cwd", "/repo", "list"]).method).toBe("approval.list");
    expect(parseCandidateCommand(["candidate", "--cwd", "/repo", "reject", "--candidate-id", "c1"]))
      .toEqual({ method: "candidate.reject", params: { candidateId: "c1" } });
  });

  test("approval resolve still accepts a positional resolution alongside --cwd", () => {
    expect(parseApprovalCommand([
      "approval", "--cwd", "/repo", "resolve", "--approval-id", "a1", "--decision", "approved", "Gates passed.",
    ]).params).toEqual({ approvalId: "a1", decision: "approved", resolution: "Gates passed." });
  });

  test("budget resolves list and the linked-hold sub-verb behind --cwd", () => {
    expect(parseBudgetCommand(["budget", "--cwd", "/repo", "list"])).toEqual({ method: "budget.list", params: {} });
    expect(parseBudgetCommand(["budget", "--cwd", "/repo", "linked-hold", "inspect", "--link-id", "a".repeat(64)]))
      .toEqual({ offline: "inspect", linkId: "a".repeat(64) });
  });

  test("mcp reads the host operand rather than the --cwd value", async () => {
    // The decisive case: --cwd was consumed positionally together with its
    // value, so `mcp --cwd /repo` reported "Unknown MCP host: /repo".
    await expect(runMcpCommand(["mcp", "--cwd", "/repo", "install", "bogus-host"]))
      .rejects.toThrow("Unknown MCP host: bogus-host");
    await expect(runMcpCommand(["mcp", "--cwd", "/repo", "bogus"]))
      .rejects.toThrow("Usage: headless mcp <serve|install|remove|status>");
  });
});

describe("usage errors name the namespace the operator has to type", () => {
  test("experimental commands print the experimental prefix", () => {
    expect(() => parseGoalCommand(["goal", "wat"])).toThrow("Usage: headless experimental goal <start|run|send|");
    expect(() => parseGoalCommand(["goal", "wat"])).not.toThrow("Usage: headless goal <");
    expect(() => parseApprovalCommand(["approval", "wat"])).toThrow("Usage: headless experimental approval <list|resolve>");
    expect(() => parseCandidateCommand(["candidate", "wat"])).toThrow("Usage: headless experimental candidate <inspect|integrate|reject>");
    expect(() => parseCollaborationCommand(["collaboration", "wat", "--goal-id", "g1"]))
      .toThrow("Usage: headless experimental collaboration <turns|messages|acknowledge|transfer-synthesizer>");
    expect(() => parseBudgetCommand(["budget", "wat"])).toThrow("Usage: headless experimental budget <list|upsert|");
  });

  test("fleet rejects an unknown namespace with the experimental prefix", async () => {
    await expect(parseFleetCommand(["fleet", "wat"])).rejects.toThrow("Usage: headless experimental fleet <health|profile");
  });
});

describe("launch and events fail on operator input before any daemon starts", () => {
  test("launch demands a backend instead of reporting an invalid --backend", async () => {
    await expect(runLaunchCommand(["launch"])).rejects.toThrow("Usage: headless experimental launch <backend>");
    await expect(runLaunchCommand(["launch", "--cwd", "/repo"])).rejects.toThrow("Usage: headless experimental launch <backend>");
    await expect(runLaunchCommand(["launch", "--cwd", "/repo"])).rejects.not.toThrow("Invalid --backend");
  });

  test("launch names the namespace in the removed opencode-serve message", async () => {
    await expect(runLaunchCommand(["launch", "opencode-serve"]))
      .rejects.toThrow("`headless experimental launch opencode-serve` was removed");
  });

  test("events reports the channel conflict as operator input, not a runtime fault", async () => {
    // A TypeError here became a generic INTERNAL_ERROR under --json.
    await expect(runEventsCommand(["events", "--errors", "--activity"])).rejects.toThrow(CliUsageError);
    await expect(runEventsCommand(["events", "--errors", "--activity"]))
      .rejects.toThrow("Choose either --errors or --activity, not both.");
  });

  /**
   * daemon/lead/ledger/receipt only export handlers that reach the daemon, so
   * they cannot be pinned behaviourally without spawning one. They were also
   * the four whose fix had no coverage at all: reverting them left every test
   * green while `daemon --cwd X` was broken again. Pin the migration itself —
   * a raw positional index in a handler IS the defect, wherever it reappears.
   */
  test("no handler reads its action from a physical argv index", () => {
    const directory = new URL("../src/cli/commands/", import.meta.url).pathname;
    const offenders: string[] = [];
    for (const entry of readdirSync(directory)) {
      if (!entry.endsWith(".ts")) continue;
      const source = readFileSync(join(directory, entry), "utf8");
      source.split("\n").forEach((line, index) => {
        if (/\b(?:args|flags|argv|rest)\[\d+\]/.test(line)) offenders.push(`${entry}:${index + 1} ${line.trim()}`);
      });
    }
    expect(offenders).toEqual([]);
  });
});
