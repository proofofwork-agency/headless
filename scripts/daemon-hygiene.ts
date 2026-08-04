/**
 * Fails when Headless daemons have strayed: bootstrapped daemons are detached
 * and have no owner once their CLI exits, so a disposable project root leaks a
 * resident daemon unless the idle watchdog or an explicit teardown reclaims it.
 *
 * Resident daemons for real checkouts are legitimate and never reported. This
 * runs first in `bun run check` (see `check:kernel`) so a machine the gate would
 * reject is reported in seconds instead of after minutes of typecheck and tests,
 * and so a stray daemon cannot skew the timing-sensitive suite that follows.
 *
 * The cost is that this reads machine-global state: a second test run in another
 * checkout holds short-lived disposable daemons, and `check` will fail on them.
 * That is a true report about the machine, not a false one — rerun once the
 * other run finishes, or reclaim with `headless experimental daemon reap`.
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
