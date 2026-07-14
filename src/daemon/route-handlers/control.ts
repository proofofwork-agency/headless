import { randomUUID } from "node:crypto";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { BudgetSchema, GrantSchema, type Job } from "../../contracts/durable";
import { HeadlessError } from "../../runtime/headless-error";
import type { DaemonFamilyHandlerRegistrations } from "../route-dispatcher";
import type { DaemonRouteContext } from "../route-context";

type ControlFamilies = Pick<DaemonFamilyHandlerRegistrations,
  | "system"
  | "lead"
  | "observer"
  | "project-trust"
  | "fleet"
  | "goal"
  | "collaboration"
  | "approval"
  | "candidate"
  | "authentication"
  | "authority"
  | "budget"
>;

export function controlRouteHandlers(context: DaemonRouteContext): ControlFamilies {
  return {
    system: {
      ping: (_params, credential) => {
        const extensions = context.extensionInfo();
        return {
          version: 2,
          projectId: context.projectId,
          projectRoot: context.projectRoot,
          principal: credential.principal,
          scopes: credential.scopes,
          experimentalSessionsEnabled: context.experimentalSessionsEnabled,
          runtime: daemonRuntimeIdentity(),
          extensionConfigDigest: extensions.digest,
          extensionAdapters: extensions.adapters,
          extensionProviders: extensions.providers,
          extensionPricing: extensions.pricing,
        };
      },
    },
    lead: {
      "lead.use": (params, credential) => context.useLead(params.host, credential),
      "lead.status": () => context.leads.status(),
      "lead.release": (_params, credential) => context.releaseLead(credential),
      "lead.attach": (params, credential) => context.leads.attach(credential.principal, params.generation),
      "lead.heartbeat": (params, credential) => context.leads.heartbeat(credential.principal, params.generation),
      "lead.disconnect": (params, credential) => context.leads.disconnect(credential.principal, params.generation),
    },
    observer: {
      "observer.snapshot": () => context.observerSnapshot(),
      "observer.events": (params) => context.observerEvents(params),
    },
    "project-trust": {
      "project.trust.status": () => context.trust.status(),
      "project.trust.grant": (params, credential) => context.trust.grant({ principal: credential.principal, ...params }),
      "project.trust.revoke": () => context.trust.revoke(),
    },
    fleet: {
      "fleet.profile.upsert": (params) => {
        const { activate, ...input } = params;
        const existing = context.fleets.get(input.id);
        const now = Date.now();
        const profile = existing
          ? context.fleets.update(existing.id, {
              ...input,
              agents: input.agents.map((agent) => {
                const prior = existing.agents.find((candidate) => candidate.id === agent.id);
                return { ...agent, createdAt: prior?.createdAt ?? now, updatedAt: now };
              }),
            })
          : context.fleets.create(input);
        if (activate) context.fleets.setActive(profile.id);
        return { profile, activeProfileId: context.fleets.snapshot().activeProfileId };
      },
      "fleet.profile.get": (params) => {
        const profile = context.fleets.get(params.profileId);
        if (!profile) throw new HeadlessError("INVALID_REQUEST", `Unknown fleet profile: ${params.profileId}`);
        return profile;
      },
      "fleet.profile.list": () => {
        const snapshot = context.fleets.snapshot();
        return { profiles: context.fleets.list(), activeProfileId: snapshot.activeProfileId };
      },
      "fleet.profile.remove": (params) => ({
        profile: context.fleets.delete(params.profileId),
        activeProfileId: context.fleets.snapshot().activeProfileId,
      }),
      "fleet.health": (params) => {
        const profile = params.profileId ? context.fleets.get(params.profileId) : context.fleets.getActive();
        if (!profile) {
          throw new HeadlessError(
            "INVALID_REQUEST",
            params.profileId ? `Unknown fleet profile: ${params.profileId}` : "No active fleet profile is configured.",
          );
        }
        return context.fleetHealth(profile);
      },
    },
    goal: {
      "goal.start": (params, credential) => context.startGoal(params, credential),
      "goal.send": (params, credential) => context.goalCoordinator.send(params.goalId, credential.principal, params.text),
      "goal.status": (params, credential) => credential.scopes.includes("admin")
        ? context.requireGoal(params.goalId).goal
        : context.goalCoordinator.status(params.goalId, credential.principal).goal,
      "goal.list": (_params, credential) => context.goalCoordinator
        .list(credential.principal, credential.scopes.includes("admin"))
        .map((record) => record.goal),
      "goal.cancel": (params, credential) => credential.scopes.includes("admin")
        ? context.cancelGoalAs(params.goalId, credential.principal)
        : context.goalCoordinator.cancel(params.goalId, credential.principal),
      "goal.result": (params, credential) => credential.scopes.includes("admin")
        ? context.requireGoal(params.goalId).result
        : context.goalCoordinator.result(params.goalId, credential.principal),
    },
    collaboration: {
      "collaboration.turns": (params, credential) => {
        const record = visibleGoal(context, params.goalId, credential);
        return {
          goalId: params.goalId,
          turns: record.turns
            .filter((turn) => turn.sequence > params.afterSequence)
            .sort((left, right) => left.sequence - right.sequence)
            .slice(0, params.limit),
        };
      },
      "collaboration.messages": (params, credential) => {
        visibleGoal(context, params.goalId, credential);
        return {
          goalId: params.goalId,
          messages: context.directedMailbox.snapshot().messages
            .filter((message) => message.collaborationId === params.goalId && message.sequence > params.afterSequence)
            .sort((left, right) => left.createdAt - right.createdAt || left.sequence - right.sequence)
            .slice(0, params.limit),
        };
      },
      "collaboration.messages.acknowledge": (params, credential) => {
        const record = context.requireGoal(params.goalId);
        const ids = new Set(params.messageIds);
        const messages = context.directedMailbox.snapshot().messages
          .filter((message) => ids.has(message.id));
        if (messages.length !== ids.size || messages.some((message) => message.collaborationId !== params.goalId)) {
          throw new HeadlessError("INVALID_REQUEST", "One or more collaboration messages do not exist in this goal.");
        }
        const coordinator = record.goal.principal === credential.principal;
        const administrator = credential.scopes.includes("admin");
        if (!administrator && !coordinator && messages.some((message) => message.recipientId !== credential.principal)) {
          throw new HeadlessError("POLICY_DENIED", "Only an addressed recipient or the authenticated goal coordinator may acknowledge collaboration messages.");
        }
        const result = context.directedMailbox.acknowledgeBatch(params.goalId, params.messageIds, {
          prune: params.prune,
        });
        return {
          goalId: params.goalId,
          acknowledgedMessageIds: result.messages.map((message) => message.id),
          pruned: result.pruned,
        };
      },
      "collaboration.transferSynthesizer": (params, credential) => context.goalCoordinator
        .transferSynthesizer(params.goalId, params.agentId, credential.principal),
    },
    approval: {
      "approval.list": (params, credential) => {
        if (params.goalId) visibleGoal(context, params.goalId, credential);
        const approvals = context.approvals.list({ collaborationId: params.goalId, status: params.status });
        if (credential.scopes.includes("admin")) return approvals;
        return approvals.filter((approval) => {
          if (approval.assignedTo === credential.principal || approval.requestedBy === credential.principal) return true;
          const goal = context.goals.get(approval.collaborationId);
          if (goal?.goal.principal === credential.principal) return true;
          return context.jobs.get(approval.collaborationId)?.principal === credential.principal;
        });
      },
      "approval.resolve": (params, credential) => context.resolveApproval(params, credential),
    },
    candidate: {
      "candidate.inspect": (params, credential) => context.candidates.inspect(params.candidateId, authorization(context, credential)),
      "candidate.integrate": (params, credential) => context.candidates.integrate(params.candidateId, authorization(context, credential)),
      "candidate.reject": (params, credential) => context.candidates.reject(params.candidateId, authorization(context, credential)),
    },
    authentication: {
      "auth.provisionObserver": (_params, credential) => context.provisionObserver(credential),
      "auth.list": (_params, credential) => context.credentials.list(credential),
      "auth.revoke": (params, credential) => context.credentials.revoke(credential, params.id),
    },
    authority: {
      "authority.grant.add": (params, credential) => {
        const now = Date.now();
        if (params.expiresAt <= now) throw new HeadlessError("INVALID_REQUEST", "Grant expiry must be in the future.");
        return context.authority.addGrant(credential.principal, GrantSchema.parse({
          ...params,
          id: params.id ?? randomUUID(),
          projectId: context.projectId,
          issuedBy: credential.principal,
          createdAt: now,
          revokedAt: null,
        }));
      },
      "authority.grant.revoke": (params, credential) => context.authority.revokeGrant(credential.principal, params.grantId),
      "authority.grant.list": () => context.authority.getState().grants,
    },
    budget: {
      "budget.upsert": (params) => {
        const existing = context.budgets.getState().budgets.find((budget) => budget.id === params.id);
        return context.budgets.upsertBudget(BudgetSchema.parse({
          ...params,
          projectId: context.projectId,
          usedRequests: existing?.usedRequests ?? 0,
          usedUsage: existing?.usedUsage ?? { input: 0, output: 0, reasoning: 0, cached: 0, providerTotal: 0 },
          usedCost: existing?.usedCost ?? { amountUsd: 0, source: "reconciled", pricingId: null, observedRequests: 0 },
          usedArtifactBytes: existing?.usedArtifactBytes ?? 0,
          updatedAt: Date.now(),
        }));
      },
      "budget.list": () => context.budgets.getState().budgets,
    },
  };
}

let cachedRuntimeIdentity: Record<string, unknown> | undefined;
const daemonStartedAt = Date.now();

function daemonRuntimeIdentity() {
  if (cachedRuntimeIdentity) return cachedRuntimeIdentity;
  const entrypoint = process.argv[1] ?? null;
  let buildDigest: string | null = null;
  if (entrypoint && existsSync(entrypoint)) {
    try {
      buildDigest = createHash("sha256").update(readFileSync(entrypoint)).digest("hex");
    } catch {
      buildDigest = null;
    }
  }
  cachedRuntimeIdentity = {
    pid: process.pid,
    entrypoint,
    buildDigest,
    startedAt: daemonStartedAt,
  };
  return cachedRuntimeIdentity;
}

function authorization(context: DaemonRouteContext, credential: { principal: string; scopes: string[] }) {
  return {
    actor: credential.principal,
    admin: credential.scopes.includes("admin"),
    canRead: (job: Job, actor: string) => context.authority.authorize({
      projectId: context.projectId,
      principal: actor,
      operation: job.mode === "write" ? "write" : "run",
      backend: job.backend,
      estimatedCostUsd: 0,
      merge: false,
    }).allowed,
  };
}

function visibleGoal(
  context: DaemonRouteContext,
  goalId: string,
  credential: { principal: string; scopes: string[] },
) {
  const record = context.requireGoal(goalId);
  if (!credential.scopes.includes("admin") && record.goal.principal !== credential.principal) {
    throw new HeadlessError("POLICY_DENIED", "Goal collaboration belongs to another authenticated principal.");
  }
  return record;
}
