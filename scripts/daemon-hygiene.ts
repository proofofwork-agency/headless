/**
 * Fails when Headless daemons have strayed: bootstrapped daemons are detached
 * and have no owner once their CLI exits, so a disposable project root leaks a
 * resident daemon unless the idle watchdog or an explicit teardown reclaims it.
 *
 * Resident daemons for real checkouts are legitimate and never reported. This
 * is deliberately not part of `bun run check`: a concurrent test run holds
 * short-lived disposable daemons, which would make the shared gate flaky.
 */
import { listDaemonInventory } from "../src/runtime/daemon-inventory";

const inventory = listDaemonInventory();
const strayed = inventory.filter((entry) => entry.strayed);

for (const entry of strayed) {
  console.error(`stray daemon pid=${entry.pid} reason=${entry.reason} root=${entry.projectRoot ?? "<unknown>"}`);
}

if (strayed.length > 0) {
  console.error(`daemon hygiene failed: ${strayed.length} stray daemon(s) of ${inventory.length} scanned.`);
  console.error("Reclaim them with: headless experimental daemon reap --confirm");
  process.exit(1);
}

console.log(`daemon hygiene passed: ${inventory.length} resident daemon(s), 0 strayed`);
