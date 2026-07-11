import { z } from "zod";
import type { AuthenticatedCredential } from "../runtime/credential-store";
import { HeadlessError } from "../runtime/headless-error";
import { assertCredentialScope } from "./auth";
import type { DaemonMethod } from "./protocol";
import { DAEMON_ROUTES, daemonRoute, type DaemonRouteFamily } from "./routes";

export type DaemonRouteParams<Method extends DaemonMethod> = z.output<(typeof DAEMON_ROUTES)[Method]["schema"]>;
export type DaemonRouteHandler<Method extends DaemonMethod> = (
  params: DaemonRouteParams<Method>,
  credential: AuthenticatedCredential,
) => unknown | Promise<unknown>;

export type DaemonRouteHandlerMap = {
  [Method in DaemonMethod]: DaemonRouteHandler<Method>;
};

type MethodForFamily<Family extends DaemonRouteFamily> = {
  [Method in DaemonMethod]: (typeof DAEMON_ROUTES)[Method]["handler"] extends Family ? Method : never;
}[DaemonMethod];

export type DaemonFamilyHandlers<Family extends DaemonRouteFamily> = {
  [Method in MethodForFamily<Family>]: DaemonRouteHandler<Method>;
};

export type DaemonFamilyHandlerRegistrations = {
  [Family in DaemonRouteFamily]: DaemonFamilyHandlers<Family>;
};

/**
 * Flatten one exhaustive registration per route family and verify at runtime
 * that no method was misplaced, duplicated, or omitted.
 */
export function createDaemonRouteHandlerMap(registrations: DaemonFamilyHandlerRegistrations): DaemonRouteHandlerMap {
  const handlers: Partial<Record<DaemonMethod, DaemonRouteHandler<DaemonMethod>>> = {};
  for (const [family, familyHandlers] of Object.entries(registrations) as Array<[
    DaemonRouteFamily,
    Record<string, DaemonRouteHandler<DaemonMethod>>,
  ]>) {
    for (const [method, handler] of Object.entries(familyHandlers) as Array<[DaemonMethod, DaemonRouteHandler<DaemonMethod>]>) {
      const route = DAEMON_ROUTES[method];
      if (!route || route.handler !== family) {
        throw new HeadlessError("INTERNAL_ERROR", `Daemon route ${method} was registered under the wrong handler family.`);
      }
      if (handlers[method]) throw new HeadlessError("INTERNAL_ERROR", `Daemon route ${method} has more than one handler.`);
      handlers[method] = handler;
    }
  }
  for (const method of Object.keys(DAEMON_ROUTES) as DaemonMethod[]) {
    if (!handlers[method]) throw new HeadlessError("INTERNAL_ERROR", `Daemon route ${method} has no registered handler.`);
  }
  return Object.freeze(handlers) as DaemonRouteHandlerMap;
}

/** Authorization, schema parsing, and handler selection share one route row. */
export function dispatchDaemonRoute(
  handlers: DaemonRouteHandlerMap,
  method: DaemonMethod,
  rawParams: unknown,
  credential: AuthenticatedCredential,
) {
  const route = daemonRoute(method);
  assertCredentialScope(credential, route.scope);
  const params = route.schema.parse(rawParams);
  const handler = handlers[method] as DaemonRouteHandler<DaemonMethod>;
  return handler(params, credential);
}
