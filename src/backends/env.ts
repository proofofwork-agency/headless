// The runner supplies an isolated HOME/identity. These keys are operational,
// not permission to inherit a host login or keychain-backed authentication.
const BASE_ENV_KEYS = new Set(["PATH", "HOME", "TMPDIR", "TERM", "SHELL", "LANG", "USER", "LOGNAME"]);

const HEADLESS_PREFIX = "HEADLESS_";

// The HEADLESS_ namespace is deny-by-default: only these exact names may reach a
// worker. It used to be allow-by-default with a deny list, and that shape failed
// the same way three times. HEADLESS_LEDGER_KEY was denied by name, then the
// keyring vars (HEADLESS_LEDGER_KEYS, _KEY_ID, _ACTIVE_KEY_ID) were added and
// silently defaulted back to allowed. The extension family was still denied by
// name only, so a future HEADLESS_EXTENSION_TOKEN would have inherited the same
// default -- and that family is high trust: _CONFIG selects the daemon extension
// modules to EXECUTE and _MANIFEST carries their pinned path+hash (see
// runtime/daemon-extensions.ts). Inverting the default makes every var written
// after this line daemon-only on the day it is written, and forces whoever wants
// a worker to see one to say so here.
//
// Everything listed is either a capability the daemon mints for this one run, or
// non-secret run identity. Nothing here reaches host state: the ledger keys,
// extension modules, HEADLESS_STATE_HOME/_RUNTIME_HOME/_RECEIPTS, _PRINCIPAL,
// _PROJECT_ROOT, _LEAD_HOST, _COMMIT, _MCP_TOOLSET and the broker listener
// policy stay daemon-side by simply not appearing.
const WORKER_HEADLESS_KEYS = new Set([
  // Recursion guard and provenance for a nested run (see backends/opencode.ts).
  "HEADLESS_DEPTH",
  "HEADLESS_PARENT_BACKEND",
  // Run-scoped daemon tool. installRunToolClient mutates these into worker.env
  // BEFORE the adapter env is built (runner/simple.ts), so stripping them here
  // would silently cut the in-worker client off from its transport or its
  // credential. The token is scoped to one job and expires; the broker token is
  // applied AFTER this boundary (applyBrokerEnvironment) and so is absent by
  // construction, not by omission.
  "HEADLESS_RUN_TOOL_SOCKET",
  "HEADLESS_RUN_TOOL_TOKEN",
  "HEADLESS_RUN_TOOL_EXPIRES_AT",
  "HEADLESS_RUN_TOOL_OPERATIONS",
  "HEADLESS_RUN_TOOL_TIMEOUT_MS",
  "HEADLESS_RUN_JOB_ID",
  "HEADLESS_RUN_SESSION_ID",
  // The same capability reached over the in-netns loopback relay instead of a
  // socket. The Linux supervisor sets these in its own process after this
  // boundary (broker/linux-relay.ts), so they are listed to keep the capability
  // working if it is ever resolved earlier. A loopback host and port are not
  // secrets; the credential above is what authenticates the call.
  "HEADLESS_RUN_TOOL_HOST",
  "HEADLESS_RUN_TOOL_PORT",
]);

/**
 * Build the environment a backend adapter may hand to a worker process.
 *
 * This is the second line, not the only one. In production it never sees
 * process.env: both callers pass worker.env from runtime/worker-environment.ts,
 * whose own allowlist (PATH, TERM, COLORTERM, LANG, TZ, NO_COLOR, LC_*) already
 * drops every HEADLESS_ var the daemon holds. Nothing recorded that dependency,
 * so state it here: keep that layer strict, and keep this one able to stand on
 * its own if a caller ever hands an adapter a richer source environment.
 */
export function buildAdapterEnv(sourceEnv: NodeJS.ProcessEnv, credentialPrefixes: string[]) {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(sourceEnv)) {
    if (!value) continue;
    // Decided before the credential arm, so a caller-supplied prefix -- even a
    // bare "HEADLESS_" -- can never re-admit daemon-only material.
    if (key.startsWith(HEADLESS_PREFIX)) {
      if (WORKER_HEADLESS_KEYS.has(key)) env[key] = value;
      continue;
    }
    if (
      BASE_ENV_KEYS.has(key) ||
      key.startsWith("LC_") ||
      key.startsWith("XDG_") ||
      credentialPrefixes.some((entry) => entry.endsWith("_") ? key.startsWith(entry) : key === entry)
    ) {
      env[key] = value;
    }
  }
  return env;
}
