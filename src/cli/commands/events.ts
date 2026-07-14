import type { HeadlessDaemonClient } from "../../daemon/client";
import type { RunEvent } from "../../contracts/run";
import { parseLogDisplayMode, selectLogEvents, strictLogIdentity, type LogChannel, type LogDisplayMode } from "../../runtime/log-presentation";
import {
  EVENT_POLL_INTERVAL_MS,
  MAX_EVENT_LIMIT,
  daemonClient,
  flagArgsBeforeSeparator,
  getArg,
  parseIntegerArg,
  signalWasReceived,
} from "../shared";

export async function runEventsCommand(args: string[]) {
  const flags = flagArgsBeforeSeparator(args);
  const follow = flags.includes("--follow") || flags.includes("-f");
  const pretty = flags.includes("--pretty") || flags.includes("-p");
  const limit = parseIntegerArg(flags, "--limit", MAX_EVENT_LIMIT) ?? 20;
  const sessionId = getArg(flags, "--session-id");
  const displayMode = parseLogDisplayMode(getArg(flags, "--display-mode"), "verbose");
  if (flags.includes("--errors") && flags.includes("--activity")) throw new TypeError("Choose either --errors or --activity, not both.");
  const channel: LogChannel = flags.includes("--errors") ? "errors" : flags.includes("--activity") ? "activity" : "all";
  const client = await daemonClient(getArg(flags, "--cwd") || process.cwd(), flags);
  await printEventSnapshots(client, { follow, pretty, limit, sessionId, displayMode, channel });
}

async function printEventSnapshots(
  client: HeadlessDaemonClient,
  options: { follow: boolean; pretty: boolean; limit: number; sessionId?: string; displayMode: LogDisplayMode; channel: LogChannel },
) {
  let cursor = 0;
  const print = async () => {
    const snapshot = await client.call<{ events: RunEvent[]; nextCursor?: number }>("events.snapshot", {
      limit: options.limit,
      sessionId: options.sessionId,
      afterCursor: cursor || undefined,
    });
    if (typeof snapshot.nextCursor === "number") cursor = Math.max(cursor, snapshot.nextCursor);
    for (const entry of presentEvents(selectLogEvents(snapshot.events, options.displayMode, options.channel), options.displayMode)) {
      console.log(options.pretty ? JSON.stringify(entry, null, 2) : JSON.stringify(entry));
    }
  };
  await print();
  if (!options.follow) return;
  console.error("Following daemon events (Ctrl-C to stop)...");
  while (!signalWasReceived()) {
    await Bun.sleep(EVENT_POLL_INTERVAL_MS);
    await print();
  }
}

function presentEvents(events: RunEvent[], mode: LogDisplayMode) {
  if (mode === "verbose") return events;
  if (mode === "strict") return events.map((event) => ({ ...event, strictIdentity: strictLogIdentity(event) }));
  return events.reduce<Array<{ event: RunEvent; repeatCount: number }>>((result, event) => {
    const previous = result.at(-1);
    const key = compactKey(event);
    if (previous && compactKey(previous.event) === key) previous.repeatCount += 1;
    else result.push({ event, repeatCount: 1 });
    return result;
  }, []);
}

function compactKey(event: RunEvent) {
  if (event.kind === "stderr" || event.kind === "stdout") return `${event.kind}:${event.text}`;
  if (event.kind === "completion") return `${event.kind}:${event.result.status}:${event.result.error?.code ?? ""}`;
  if (event.kind === "lifecycle") return `${event.kind}:${event.state}:${event.detail ?? ""}`;
  if (event.kind === "policy") return `${event.kind}:${event.decision}:${event.rule}:${event.reason}`;
  return `${event.kind}:${event.eventId}`;
}
