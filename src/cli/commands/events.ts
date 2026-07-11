import type { HeadlessDaemonClient } from "../../daemon/client";
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
  const client = await daemonClient(getArg(flags, "--cwd") || process.cwd(), flags);
  await printEventSnapshots(client, { follow, pretty, limit, sessionId });
}

async function printEventSnapshots(
  client: HeadlessDaemonClient,
  options: { follow: boolean; pretty: boolean; limit: number; sessionId?: string },
) {
  const seen = new Set<string>();
  const print = async () => {
    const snapshot = await client.call<{ events: Array<Record<string, unknown>> }>("events.snapshot", {
      limit: options.limit,
      sessionId: options.sessionId,
    });
    for (const event of snapshot.events) {
      const id = typeof event.eventId === "string" ? event.eventId : JSON.stringify(event);
      if (seen.has(id)) continue;
      seen.add(id);
      console.log(options.pretty ? JSON.stringify(event, null, 2) : JSON.stringify(event));
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
