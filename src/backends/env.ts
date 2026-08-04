// The runner supplies an isolated HOME/identity. These keys are operational,
// not permission to inherit a host login or keychain-backed authentication.
const BASE_ENV_KEYS = new Set(["PATH", "HOME", "TMPDIR", "TERM", "SHELL", "LANG", "USER", "LOGNAME"]);
const DAEMON_ONLY_HEADLESS_KEYS = new Set([
  "HEADLESS_EXTENSION_CONFIG",
  "HEADLESS_EXTENSION_MANIFEST",
]);
// Deny the ledger family by prefix, not by name: HEADLESS_LEDGER_KEY was denied
// individually, then the keyring vars (HEADLESS_LEDGER_KEYS, _KEY_ID,
// _ACTIVE_KEY_ID) were added and silently defaulted back to allowed. A worker
// holding any ledger signing material can forge its own audit trail, and no
// adapter ever writes the ledger, so the whole family is daemon-only.
const DAEMON_ONLY_HEADLESS_PREFIXES = ["HEADLESS_LEDGER"];

function isDaemonOnlyHeadlessKey(key: string) {
  return DAEMON_ONLY_HEADLESS_KEYS.has(key)
    || DAEMON_ONLY_HEADLESS_PREFIXES.some((prefix) => key.startsWith(prefix));
}

export function buildAdapterEnv(sourceEnv: NodeJS.ProcessEnv, credentialPrefixes: string[]) {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(sourceEnv)) {
    if (!value) continue;
    // Checked before the allow arms so a caller-supplied credential prefix can
    // never re-admit daemon-only material.
    if (isDaemonOnlyHeadlessKey(key)) continue;
    if (
      BASE_ENV_KEYS.has(key) ||
      key.startsWith("LC_") ||
      key.startsWith("XDG_") ||
      key.startsWith("HEADLESS_") ||
      credentialPrefixes.some((entry) => entry.endsWith("_") ? key.startsWith(entry) : key === entry)
    ) {
      env[key] = value;
    }
  }
  return env;
}
