import { appendNote, getReadContext, getTaskState, proposeFinal, recordArtifact } from "../../runtime/ledger-api";
import { HeadlessError } from "../../runtime/headless-error";
import { redactAndTruncate } from "../../runtime/redaction";
import { appendEvent, getOrCreateSession } from "../../runtime/session";
import { authenticatedLedgerEvent, sanitizeIdentityFields } from "../auth";
import { boundedChatId, optionalNumber, optionalString, stringArray, stringParam } from "../route-params";
import type { DaemonFamilyHandlerRegistrations } from "../route-dispatcher";
import type { DaemonRouteContext } from "../route-context";

type CooperationFamilies = Pick<DaemonFamilyHandlerRegistrations, "ledger" | "messages">;

export function cooperationRouteHandlers(context: DaemonRouteContext): CooperationFamilies {
  return {
    ledger: {
      "ledger.note": (params, credential) => appendNote({
        cwd: context.projectRoot,
        state: context.stateOptions,
        authenticatedPrincipal: credential.principal,
        sessionId: optionalString(params.sessionId),
        text: stringParam(params, "text"),
        handlesHandoffId: optionalString(params.handlesHandoffId),
      }),
      "ledger.artifact": (params, credential) => recordArtifact({
        cwd: context.projectRoot,
        state: context.stateOptions,
        authenticatedPrincipal: credential.principal,
        sessionId: optionalString(params.sessionId),
        kind: stringParam(params, "kind"),
        title: stringParam(params, "title"),
        summary: stringParam(params, "summary"),
        status: optionalString(params.status) as "passed" | "failed" | "blocked" | "unknown" | "skipped" | "timed_out" | undefined,
        evidence: stringArray(params.evidence),
      }),
      "ledger.context": (params, credential) => getReadContext({
        cwd: context.projectRoot,
        state: context.stateOptions,
        authenticatedPrincipal: credential.principal,
        includeAllPrincipals: credential.scopes.includes("admin"),
        sessionId: optionalString(params.sessionId),
        view: optionalString(params.view) as "summary" | "recent" | "raw" | undefined,
        limit: optionalNumber(params.limit),
      }),
      "ledger.task": (params, credential) => getTaskState({
        cwd: context.projectRoot,
        state: context.stateOptions,
        authenticatedPrincipal: credential.principal,
        includeAllPrincipals: credential.scopes.includes("admin"),
        sessionId: optionalString(params.sessionId),
      }),
      "ledger.proposeFinal": (params, credential) => proposeFinal({
        cwd: context.projectRoot,
        state: context.stateOptions,
        authenticatedPrincipal: credential.principal,
        sessionId: optionalString(params.sessionId),
        summary: stringParam(params, "summary"),
        evidence: stringParam(params, "evidence"),
        remainingRisk: optionalString(params.remainingRisk),
        handlesHandoffIds: stringArray(params.handlesHandoffIds),
      }),
      "ledger.event": (params, credential) => {
        const type = stringParam(params, "type");
        const session = getOrCreateSession({
          cwd: context.projectRoot,
          state: context.stateOptions,
          authenticatedPrincipal: credential.principal,
          sessionId: optionalString(params.sessionId),
        });
        if (!params.payload || typeof params.payload !== "object" || Array.isArray(params.payload)) {
          throw new HeadlessError("INVALID_REQUEST", "Ledger event payload must be an object.");
        }
        return appendEvent(
          session,
          authenticatedLedgerEvent(type, params.payload as Record<string, unknown>, credential.principal),
        );
      },
    },
    messages: {
      "messages.push": (params, credential) => {
        const chatId = boundedChatId(params.chatId);
        const content = redactAndTruncate(stringParam(params, "content"), 65_536).text;
        const meta = params.meta && typeof params.meta === "object" && !Array.isArray(params.meta)
          ? sanitizeIdentityFields(params.meta as Record<string, unknown>)
          : {};
        const queued = context.messages.enqueue(credential.principal, chatId, content, meta);
        const session = getOrCreateSession({
          cwd: context.projectRoot,
          state: context.stateOptions,
          authenticatedPrincipal: credential.principal,
          sessionId: chatId,
        });
        appendEvent(session, {
          type: "message",
          source: credential.principal,
          content,
          message: {
            from: credential.principal,
            to: optionalString(params.to) ?? "channel",
            content,
            kind: "channel",
          },
          meta,
        });
        return queued;
      },
      "messages.pull": (params, credential) => {
        const chatId = boundedChatId(params.chatId);
        const limit = Math.max(1, Math.min(optionalNumber(params.limit) ?? 20, 50));
        const messages = context.messages.listUndrained(credential.principal, chatId, limit);
        context.messages.markDrained(credential.principal, messages.map((message) => message.id));
        return { messages };
      },
      "messages.markPushed": (params, credential) => {
        context.messages.markPushed(credential.principal, stringParam(params, "messageId"));
        return { ok: true };
      },
    },
  };
}
