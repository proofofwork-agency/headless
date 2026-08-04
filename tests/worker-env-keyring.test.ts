import { describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { buildAdapterEnv } from "../src/backends/env";
import { ledgerIntegrityOptionsFromEnv } from "../src/runtime/ledger-v2";

const ACTIVE_KEY = randomBytes(32).toString("base64");
const ROTATED_KEY = randomBytes(32).toString("base64");

// Every env var ledgerIntegrityOptionsFromEnv reads. A worker that can read any
// of it can sign forged ledger entries, so none of it may cross into an adapter.
function ledgerKeyEnv(): NodeJS.ProcessEnv {
  return {
    HEADLESS_LEDGER_KEY: ACTIVE_KEY,
    HEADLESS_LEDGER_KEY_ID: "primary",
    HEADLESS_LEDGER_KEYS: JSON.stringify({ primary: ACTIVE_KEY, rotated: ROTATED_KEY }),
    HEADLESS_LEDGER_ACTIVE_KEY_ID: "primary",
  };
}

describe("adapter environments never carry ledger key material", () => {
  test("drops every ledger key env var the daemon reads", () => {
    const source = { PATH: "/usr/bin:/bin", HEADLESS_DEPTH: "0", ...ledgerKeyEnv() };
    // Guard: the fixture really is live key material before the boundary.
    expect(ledgerIntegrityOptionsFromEnv(source).hmacKey).toBeTruthy();

    const env = buildAdapterEnv(source, ["ANTHROPIC_API_KEY"]);

    for (const key of Object.keys(ledgerKeyEnv())) expect(env[key]).toBeUndefined();
    // Name-independent: no key bytes survive under any name (aliasing, prefixes).
    for (const value of Object.values(env)) {
      expect(value).not.toContain(ACTIVE_KEY);
      expect(value).not.toContain(ROTATED_KEY);
    }
    // Semantic form: the adapter env yields no ledger integrity keys at all.
    expect(ledgerIntegrityOptionsFromEnv(env)).toEqual({
      hmacKey: undefined,
      hmacKeyId: undefined,
      hmacKeyring: undefined,
      activeHmacKeyId: undefined,
      hmacKeyOrigins: {},
    });
    // Non-secret operational vars still pass, so the rule is not over-broad.
    expect(env.PATH).toBe("/usr/bin:/bin");
    expect(env.HEADLESS_DEPTH).toBe("0");
  });

  test("denies the whole HEADLESS_LEDGER family, not just today's names", () => {
    const env = buildAdapterEnv({
      PATH: "/bin",
      HEADLESS_LEDGER_SIGNING_KEY: ACTIVE_KEY,
      HEADLESS_LEDGER_ANCHOR_SECRET: ROTATED_KEY,
    }, []);
    expect(env.HEADLESS_LEDGER_SIGNING_KEY).toBeUndefined();
    expect(env.HEADLESS_LEDGER_ANCHOR_SECRET).toBeUndefined();
    expect(Object.keys(env)).toEqual(["PATH"]);
  });

  test("a credential prefix cannot re-admit daemon-only material", () => {
    const env = buildAdapterEnv(
      { PATH: "/bin", ...ledgerKeyEnv(), HEADLESS_EXTENSION_CONFIG: "/host/extensions.json" },
      ["HEADLESS_LEDGER_KEY", "HEADLESS_", "HEADLESS_EXTENSION_CONFIG"],
    );
    expect(env.HEADLESS_LEDGER_KEY).toBeUndefined();
    expect(env.HEADLESS_LEDGER_KEYS).toBeUndefined();
    expect(env.HEADLESS_EXTENSION_CONFIG).toBeUndefined();
  });
});
