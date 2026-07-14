import type { DaemonFamilyHandlerRegistrations } from "../route-dispatcher";
import type { DaemonRouteContext } from "../route-context";
type LoopFamilies = Pick<DaemonFamilyHandlerRegistrations, "loop">;
export function loopRouteHandlers(context: DaemonRouteContext): LoopFamilies {
  return { loop: {
    "loop.start": (params, credential) => context.startLoop(params.policy, credential),
    "loop.list": (_params, credential) => context.listLoops(credential),
    "loop.status": (params, credential) => context.statusLoop(params.loopId, credential),
    "loop.pause": (params, credential) => context.pauseLoop(params.loopId, credential),
    "loop.resume": (params, credential) => context.resumeLoop(params.loopId, credential),
    "loop.cancel": (params, credential) => context.cancelLoop(params.loopId, credential),
  } };
}
