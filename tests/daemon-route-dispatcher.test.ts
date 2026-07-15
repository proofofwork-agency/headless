import { describe, expect, test } from "bun:test";
import type { AuthenticatedCredential } from "../src/runtime/credential-store";
import { HeadlessError } from "../src/runtime/headless-error";
import { DaemonMethodSchema, type DaemonMethod } from "../src/daemon/protocol";
import {
  createDaemonRouteHandlerMap,
  dispatchDaemonRoute,
  type DaemonFamilyHandlerRegistrations,
} from "../src/daemon/route-dispatcher";
import { DAEMON_ROUTES, parseDaemonRouteParams, type DaemonRouteFamily } from "../src/daemon/routes";

const rootCredential: AuthenticatedCredential = {
  id: "root",
  principal: "owner",
  kind: "root",
  scopes: ["admin"],
  createdAt: 1,
  expiresAt: null,
  revokedAt: null,
};

const integrationCredential: AuthenticatedCredential = {
  id: "integration:mcp",
  principal: "integration:mcp",
  kind: "integration",
  scopes: ["run", "session", "ledger:read", "ledger:write", "messages", "council", "gate"],
  createdAt: 1,
  expiresAt: null,
  revokedAt: null,
};

describe("typed daemon route dispatcher", () => {
  test("registers every protocol method exactly once under its declared family", async () => {
    expect(Object.keys(DAEMON_ROUTES).sort()).toEqual([...DaemonMethodSchema.options].sort());
    const handlers = createDaemonRouteHandlerMap(registrations());
    expect(await dispatchDaemonRoute(handlers, "ping", {}, rootCredential)).toEqual({ method: "ping", family: "system", params: {} });
    expect(await dispatchDaemonRoute(handlers, "messages.pull", { chatId: "chat-one" }, rootCredential)).toEqual({
      method: "messages.pull",
      family: "messages",
      params: { chatId: "chat-one", limit: 20 },
    });
  });

  test("fails construction for a missing or misplaced handler", () => {
    const missing = registrationsRecord();
    delete missing.system!.ping;
    expect(() => createDaemonRouteHandlerMap(missing as unknown as DaemonFamilyHandlerRegistrations))
      .toThrow("has no registered handler");

    const misplaced = registrationsRecord();
    misplaced.fleet!.ping = misplaced.system!.ping!;
    delete misplaced.system!.ping;
    expect(() => createDaemonRouteHandlerMap(misplaced as unknown as DaemonFamilyHandlerRegistrations))
      .toThrow("wrong handler family");
  });

  test("authorizes before parsing and never invokes a denied handler", () => {
    let invoked = false;
    const values = registrationsRecord();
    values.authentication!["auth.list"] = () => { invoked = true; };
    const handlers = createDaemonRouteHandlerMap(values as unknown as DaemonFamilyHandlerRegistrations);
    expect(() => dispatchDaemonRoute(handlers, "auth.list", { projectRoot: "/tmp/attacker" }, integrationCredential))
      .toThrow(HeadlessError);
    try {
      dispatchDaemonRoute(handlers, "auth.list", {}, integrationCredential);
    } catch (error) {
      expect(error).toMatchObject({ code: "POLICY_DENIED", retryable: false });
    }
    expect(invoked).toBe(false);
  });

  test("strictly rejects identity, project-root, and credential-path injection on formerly loose families", () => {
    const valid: Partial<Record<DaemonMethod, Record<string, unknown>>> = {
      "ledger.note": { text: "note" },
      "ledger.artifact": { kind: "test", title: "Artifact", summary: "summary" },
      "ledger.context": {},
      "ledger.verify": {},
      "ledger.task": {},
      "ledger.proposeFinal": { summary: "done", evidence: "tests" },
      "ledger.event": { type: "message", payload: { content: "hello" } },
      "messages.push": { chatId: "chat", content: "hello" },
      "messages.pull": { chatId: "chat" },
      "messages.markPushed": { messageId: "message" },
      "council.run": { question: "review this" },
      "gate.run": {},
      "session.create": { backend: "codex" },
      "session.send": { sessionId: "session", prompt: "continue" },
      "session.resume": { sessionId: "session", prompt: "resume" },
    };
    for (const [method, params] of Object.entries(valid) as Array<[DaemonMethod, Record<string, unknown>]>) {
      expect(() => parseDaemonRouteParams(method, params)).not.toThrow();
      for (const [key, value] of [
        ["principal", "attacker"],
        ["projectRoot", "/tmp/other"],
        ["credentialPath", "/tmp/token"],
      ] as const) {
        expect(() => parseDaemonRouteParams(method, { ...params, [key]: value })).toThrow();
      }
    }
  });
});

type MutableRegistrations = Record<DaemonRouteFamily, Record<string, (params: unknown) => unknown>>;

function registrations() {
  return registrationsRecord() as unknown as DaemonFamilyHandlerRegistrations;
}

function registrationsRecord(): MutableRegistrations {
  const values = Object.fromEntries(
    [...new Set(Object.values(DAEMON_ROUTES).map((route) => route.handler))]
      .map((family) => [family, {}]),
  ) as MutableRegistrations;
  for (const [method, route] of Object.entries(DAEMON_ROUTES) as Array<[DaemonMethod, (typeof DAEMON_ROUTES)[DaemonMethod]]>) {
    values[route.handler][method] = (params) => ({ method, family: route.handler, params });
  }
  return values;
}
