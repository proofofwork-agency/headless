// USER/LOGNAME are non-secret identity vars, but they are required for
// macOS Keychain access — Claude Code stores its OAuth token there ("Claude
// Safe Storage"), so stripping them makes `claude -p` report "Not logged in".
const BASE_ENV_KEYS = new Set(["PATH", "HOME", "TMPDIR", "TERM", "SHELL", "LANG", "USER", "LOGNAME"]);

export function buildAdapterEnv(sourceEnv: NodeJS.ProcessEnv, credentialPrefixes: string[]) {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(sourceEnv)) {
    if (!value) continue;
    if (BASE_ENV_KEYS.has(key) || key.startsWith("LC_") || key.startsWith("XDG_") || key.startsWith("HEADLESS_") || credentialPrefixes.some((prefix) => key.startsWith(prefix))) {
      env[key] = value;
    }
  }
  return env;
}
