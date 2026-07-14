import type { EventInput } from "../runtime/events";
import type { AuthenticatedCredential, CredentialScope } from "../runtime/credential-store";
import { HeadlessError } from "../runtime/headless-error";
import type { DaemonMethod } from "./protocol";
import { daemonRoute } from "./routes";

export const CLIENT_LEDGER_EVENT_TYPES = new Set([
  "message",
  "handoff",
  "ask_for_more_work",
  "ask_for_backup",
  "consensus_vote",
  "release_gate",
  "idle_action_result",
]);

const IDENTITY_FIELDS = new Set([
  "actor",
  "agent",
  "authenticatedPrincipal",
  "authorization",
  "claimedBy",
  "coordinator",
  "credential",
  "credentialId",
  "createdBy",
  "decidedBy",
  "grant",
  "grantId",
  "issuedBy",
  "mergeAuthority",
  "owner",
  "principal",
  "projectId",
  "requestedBy",
  "role",
  "scopes",
  "source",
  "updatedBy",
]);

export function requiredScope(method: DaemonMethod): CredentialScope | null {
  return daemonRoute(method).scope;
}

export function assertCredentialScope(credential: AuthenticatedCredential, scope: CredentialScope | null) {
  if (scope === null || credential.scopes.includes("admin") || credential.scopes.includes(scope)) return;
  throw new HeadlessError("POLICY_DENIED", `Credential ${credential.id} is not authorized for ${scope}.`);
}

export function assertPrincipalOwns(credential: AuthenticatedCredential, resourcePrincipal: string, resource: string) {
  if (credential.scopes.includes("admin") || credential.principal === resourcePrincipal) return;
  throw new HeadlessError("POLICY_DENIED", `${resource} belongs to another authenticated principal.`);
}

/**
 * Rebuild a client-originated ledger event while dropping identity and
 * authority claims. The authenticated connection is the sole source of actor
 * identity; selected typed fields are then assigned from that principal.
 */
export function authenticatedLedgerEvent(
  type: string,
  payload: Record<string, unknown>,
  principal: string,
): EventInput {
  if (!CLIENT_LEDGER_EVENT_TYPES.has(type)) {
    throw new HeadlessError("INVALID_REQUEST", `Ledger event type ${type} is not allowed over the daemon protocol.`);
  }
  const sanitized = sanitizeObject(payload);
  const event: Record<string, unknown> = {
    ...sanitized,
    type,
    source: principal,
  };
  const meta = isObject(sanitized.meta) ? sanitizeObject(sanitized.meta) : {};

  if (type === "consensus_vote") {
    event.meta = { ...meta, agent: principal };
  } else if (type === "ask_for_more_work" || type === "ask_for_backup") {
    event.meta = { ...meta, from: principal };
  } else if (Object.keys(meta).length > 0) {
    event.meta = meta;
  }

  if (type === "message") {
    const message = isObject(sanitized.message) ? sanitizeObject(sanitized.message) : {};
    event.message = {
      ...message,
      from: principal,
      to: boundedString(message.to, "channel", 160),
      content: boundedString(message.content, boundedString(event.content, "", 65_536), 65_536),
      kind: boundedString(message.kind, "direct", 64),
    };
  }
  if (type === "handoff") {
    const handoff = isObject(sanitized.handoff) ? sanitizeObject(sanitized.handoff) : {};
    event.handoff = {
      ...handoff,
      from: principal,
      to: boundedString(handoff.to, "coordinator", 160),
      reason: boundedString(handoff.reason, "", 16_384),
      ask: boundedString(handoff.ask, boundedString(event.content, "", 16_384), 16_384),
    };
  }
  return event as EventInput;
}

export function sanitizeIdentityFields(value: Record<string, unknown>) {
  return sanitizeObject(value);
}

function sanitizeObject(value: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (IDENTITY_FIELDS.has(key)) continue;
    result[key] = sanitizeValue(entry);
  }
  return result;
}

function sanitizeValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeValue);
  if (isObject(value)) return sanitizeObject(value);
  return value;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function boundedString(value: unknown, fallback: string, max: number) {
  return typeof value === "string" && value.length > 0 ? value.slice(0, max) : fallback;
}
