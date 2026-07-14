import { createDaemonRouteHandlerMap, type DaemonFamilyHandlerRegistrations } from "../route-dispatcher";
import type { DaemonRouteContext } from "../route-context";
import { controlRouteHandlers } from "./control";
import { cooperationRouteHandlers } from "./cooperation";
import { workRouteHandlers } from "./work";
import { skillRouteHandlers } from "./skill";
import { loopRouteHandlers } from "./loop";

export function createDaemonRouteHandlers(context: DaemonRouteContext) {
  const registrations = {
    ...controlRouteHandlers(context),
    ...cooperationRouteHandlers(context),
    ...workRouteHandlers(context),
    ...skillRouteHandlers(context),
    ...loopRouteHandlers(context),
  } satisfies DaemonFamilyHandlerRegistrations;
  return createDaemonRouteHandlerMap(registrations);
}
