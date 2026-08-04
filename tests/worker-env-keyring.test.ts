import { describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildAdapterEnv } from "../src/backends/env";
import { ledgerIntegrityOptionsFromEnv } from "../src/runtime/ledger-v2";
import { installRunToolClient } from "../src/runtime/run-tool-client";
import { createWorkerEnvironment } from "../src/runtime/worker-environment";

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

describe("the HEADLESS_ namespace is daemon-only by default", () => {
  test("denies a variable that did not exist when the boundary was written", () => {
    // The whole point of the inversion. This name appears nowhere in src and no
    // list was edited to make it fail closed -- if this test ever needs a code
    // change to pass, the boundary has drifted back to allow-by-default.
    const env = buildAdapterEnv({
      PATH: "/bin",
      HEADLESS_TOTALLY_NEW_SECRET: "s3cret",
      HEADLESS_EXTENSION_TOKEN: "t0ken",
      HEADLESS_LEDGER_SIGNING_KEY: "k3y",
    }, []);
    expect(Object.keys(env)).toEqual(["PATH"]);
  });

  test("a credential prefix cannot admit an unknown daemon variable either", () => {
    // Adapters own credentialPrefixes, so that arm must not be a way back in.
    const env = buildAdapterEnv(
      { PATH: "/bin", HEADLESS_TOTALLY_NEW_SECRET: "s3cret", ANTHROPIC_API_KEY: "provider" },
      ["HEADLESS_", "HEADLESS_TOTALLY_NEW_SECRET", "ANTHROPIC_API_KEY"],
    );
    expect(env.HEADLESS_TOTALLY_NEW_SECRET).toBeUndefined();
    // Not over-broad: a real provider credential still crosses.
    expect(env.ANTHROPIC_API_KEY).toBe("provider");
  });

  test("keeps the run-scoped capability the daemon mints for this worker", async () => {
    // installRunToolClient mutates worker.env BEFORE the adapter env is built
    // (runner/simple.ts), so every HEADLESS_ var it injects has to survive this
    // pass or the in-worker client loses its transport or its credential.
    const base = mkdtempSync(join(tmpdir(), "hl-runtool-"));
    const socketPath = join(base, "run-tool.sock");
    const server = createServer();
    const worker = createWorkerEnvironment({ baseDir: join(base, "workers"), sourceEnv: { PATH: "/bin" } });
    try {
      // installRunToolClient rejects anything that is not a live socket, so the
      // listener has to be bound before the capability is minted.
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(socketPath, resolve);
      });
      const injected = installRunToolClient(worker, {
        socketPath,
        token: `hlt_${randomBytes(32).toString("base64url")}`,
        expiresAt: Date.now() + 60_000,
        jobId: "job-1",
        sessionId: "session-1",
        operations: ["run.delegate"],
      });
      const capability = Object.keys(injected).filter((key) => key.startsWith("HEADLESS_"));
      expect(capability.length).toBeGreaterThan(0);

      const env = buildAdapterEnv(injected, []);

      for (const key of capability) expect(env[key]).toBe(injected[key]);
      // The broker token is applied after this boundary, so it is absent here by
      // construction; assert that rather than letting a future move go unnoticed.
      expect(env.HEADLESS_BROKER_TOKEN).toBeUndefined();
    } finally {
      server.close();
      worker.cleanup();
      rmSync(base, { recursive: true, force: true });
    }
  });
});
