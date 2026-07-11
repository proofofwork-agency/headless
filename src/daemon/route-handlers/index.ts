import { createDaemonRouteHandlerMap, type DaemonFamilyHandlerRegistrations } from "../route-dispatcher";
import type { DaemonRouteContext } from "../route-context";
import { controlRouteHandlers } from "./control";
import { cooperationRouteHandlers } from "./cooperation";
import { workRouteHandlers } from "./work";

export function createDaemonRouteHandlers(context: DaemonRouteContext) {
  const registrations = {
    ...controlRouteHandlers(context),
    ...cooperationRouteHandlers(context),
    ...workRouteHandlers(context),
  } satisfies DaemonFamilyHandlerRegistrations;
  return createDaemonRouteHandlerMap(registrations);
}
