import { describe, expect, test } from "bun:test";
import {
  assertCredentialScope,
  assertPrincipalOwns,
  authenticatedLedgerEvent,
  requiredScope,
} from "../src/daemon/auth";
import type { AuthenticatedCredential } from "../src/runtime/credential-store";

const integration: AuthenticatedCredential = {
  id: "integration:mcp",
  principal: "integration:mcp",
  kind: "integration",
  scopes: ["run", "task", "ledger:read", "ledger:write", "messages"],
  createdAt: 1,
  expiresAt: null,
  revokedAt: null,
};

describe("daemon request authorization", () => {
  test("maps every public operation to an explicit credential scope", () => {
    expect(requiredScope("ping")).toBeNull();
    expect(requiredScope("auth.list")).toBe("admin");
    expect(requiredScope("run.submit")).toBe("run");
    expect(requiredScope("events.wait")).toBe("run");
    expect(requiredScope("task.claim")).toBe("task");
    expect(requiredScope("ledger.context")).toBe("ledger:read");
    expect(requiredScope("ledger.event")).toBe("ledger:write");
    expect(requiredScope("ledger.repairTail")).toBe("admin");
    expect(requiredScope("messages.pull")).toBe("messages");
    expect(requiredScope("council.run")).toBe("council");
    expect(requiredScope("gate.run")).toBe("gate");
    expect(requiredScope("orchestrator.start")).toBe("orchestrator");
    expect(requiredScope("session.resume")).toBe("session");
  });

  test("denies missing scopes and cross-principal resource access", () => {
    expect(() => assertCredentialScope(integration, "run")).not.toThrow();
    expect(() => assertCredentialScope(integration, "orchestrator")).toThrow("not authorized");
    expect(() => assertPrincipalOwns(integration, integration.principal, "Job")).not.toThrow();
    expect(() => assertPrincipalOwns(integration, "coordinator", "Job")).toThrow("another authenticated principal");
  });

  test("derives message, vote, and handoff identities from authentication", () => {
    const attack = {
      source: "coordinator",
      actor: "coordinator",
      principal: "coordinator",
      content: "safe content",
      meta: {
        claimedBy: "coordinator",
        agent: "coordinator",
        grantId: "grant-admin",
        nested: { coordinator: true, issuedBy: "coordinator", keep: "yes" },
      },
      message: { from: "coordinator", to: "reviewer", content: "hello" },
      handoff: { from: "coordinator", to: "reviewer", ask: "review", reason: "test" },
    };

    const message = authenticatedLedgerEvent("message", attack, integration.principal) as unknown as {
      source: string; message: { from: string };
    };
    const vote = authenticatedLedgerEvent("consensus_vote", attack, integration.principal) as unknown as {
      meta: { agent: string; grantId?: string; nested: Record<string, unknown> };
    };
    const handoff = authenticatedLedgerEvent("handoff", attack, integration.principal) as unknown as {
      handoff: { from: string };
    };

    expect(message.source).toBe(integration.principal);
    expect(message.message.from).toBe(integration.principal);
    expect(vote.meta.agent).toBe(integration.principal);
    expect(handoff.handoff.from).toBe(integration.principal);
    expect(vote.meta.grantId).toBeUndefined();
    expect(vote.meta.nested).toEqual({ keep: "yes" });
  });

  test("does not admit client-authored finality decisions or legacy task claims", () => {
    expect(() => authenticatedLedgerEvent("finality_decision", { content: "approved" }, integration.principal))
      .toThrow("not allowed");
    expect(() => authenticatedLedgerEvent("task_claim", { content: "claimed" }, integration.principal))
      .toThrow("not allowed");
  });
});
