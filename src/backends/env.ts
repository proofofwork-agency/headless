// The runner supplies an isolated HOME/identity. These keys are operational,
// not permission to inherit a host login or keychain-backed authentication.
const BASE_ENV_KEYS = new Set(["PATH", "HOME", "TMPDIR", "TERM", "SHELL", "LANG", "USER", "LOGNAME"]);
const DAEMON_ONLY_HEADLESS_KEYS = new Set([
  "HEADLESS_LEDGER_KEY",
  "HEADLESS_EXTENSION_CONFIG",
  "HEADLESS_EXTENSION_MANIFEST",
]);

export function buildAdapterEnv(sourceEnv: NodeJS.ProcessEnv, credentialPrefixes: string[]) {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(sourceEnv)) {
    if (!value) continue;
    if (
      BASE_ENV_KEYS.has(key) ||
      key.startsWith("LC_") ||
      key.startsWith("XDG_") ||
      (key.startsWith("HEADLESS_") && !DAEMON_ONLY_HEADLESS_KEYS.has(key)) ||
      credentialPrefixes.some((entry) => entry.endsWith("_") ? key.startsWith(entry) : key === entry)
    ) {
      env[key] = value;
    }
  }
  return env;
}
