import { describe, expect, test } from "bun:test";
import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HeadlessError } from "../src/runtime/headless-error";
import {
  LedgerV2,
  ledgerIntegrityOptionsFromEnv,
  repairLedgerPartialTail,
  verifyLedgerChain,
} from "../src/runtime/ledger-v2";

const WEAK_KEY = "sixteen-char-key"; // 16 chars — the former floor
const PROJECT_ID = createHash("sha256").update("ledger-keys").digest("hex");

function strongKey() {
  return randomBytes(32).toString("base64");
}

function withRoot<T>(run: (root: string) => T): T {
  const root = mkdtempSync(join(tmpdir(), "headless-ledger-keys-"));
  try {
    return run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/**
 * A chain as the previous binary wrote it, when the floor was 16 characters.
 * The current writer refuses to produce this, which is exactly why an operator
 * who already has one must still be able to read it.
 */
function writeLegacyChain(ledgerPath: string, key: string, keyId: string, count = 2) {
  let previousHash: string | null = null;
  const lines: string[] = [];
  for (let sequence = 1; sequence <= count; sequence += 1) {
    const withoutHash = {
      version: 2,
      sequence,
      timestamp: 1_700_000_000_000 + sequence,
      projectId: PROJECT_ID,
      principal: "legacy-operator",
      eventId: randomUUID(),
      previousHash,
      integrity: { algorithm: "hmac-sha256", keyId },
      type: "legacy_history_event",
      payload: { note: `record ${sequence}` },
    };
    const hash = createHmac("sha256", key).update(JSON.stringify(withoutHash)).digest("hex");
    previousHash = hash;
    lines.push(JSON.stringify({ ...withoutHash, hash }));
  }
  writeFileSync(ledgerPath, `${lines.join("\n")}\n`, { mode: 0o600 });
  return lines.length;
}

describe("ledger HMAC key floor scoping", () => {
  test("a weak key is read, not refused: history stays verifiable", () => {
    // The floor exists to stop new records carrying false tamper-evidence.
    // Refusing to parse a weak key would only deny an operator their own history.
    const options = ledgerIntegrityOptionsFromEnv({
      HEADLESS_LEDGER_KEY: WEAK_KEY,
      HEADLESS_LEDGER_KEY_ID: "legacy",
    });
    expect(options.hmacKey).toBe(WEAK_KEY);
    expect(options.hmacKeyOrigins).toEqual({ legacy: "HEADLESS_LEDGER_KEY" });

    withRoot((root) => {
      const ledgerPath = join(root, "ledger.jsonl");
      const written = writeLegacyChain(ledgerPath, WEAK_KEY, "legacy");

      const verdict = verifyLedgerChain({ ledgerPath, projectId: PROJECT_ID, ...options });
      expect(verdict.ok).toBe(true);
      expect(verdict.recordsChecked).toBe(written);
      expect(verdict.integrity).toEqual({ algorithm: "hmac-sha256", keyIds: ["legacy"] });

      // The operator is told the evidence is weak rather than misled by a bare "intact".
      expect(verdict.weakKeys?.keyIds).toEqual(["legacy"]);
      expect(verdict.weakKeys?.reason).toMatch(/openssl rand -base64 32/);

      // The same chain is readable through the ledger the daemon opens.
      const ledger = new LedgerV2({
        ledgerPath,
        readModelPath: join(root, "read.json"),
        projectId: PROJECT_ID,
        principal: "legacy-operator",
        ...options,
      });
      expect(ledger.readAll()).toHaveLength(written);
      expect(ledger.weakIntegrityKeyIds).toEqual(["legacy"]);
    });
  });

  test("a weak active key still refuses to sign new records", () => {
    withRoot((root) => {
      const ledgerPath = join(root, "ledger.jsonl");
      writeLegacyChain(ledgerPath, WEAK_KEY, "legacy");
      const ledger = new LedgerV2({
        ledgerPath,
        readModelPath: join(root, "read.json"),
        projectId: PROJECT_ID,
        principal: "legacy-operator",
        ...ledgerIntegrityOptionsFromEnv({ HEADLESS_LEDGER_KEY: WEAK_KEY, HEADLESS_LEDGER_KEY_ID: "legacy" }),
      });

      let thrown: unknown;
      try {
        ledger.append("should_not_write", { x: 1 });
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(HeadlessError);
      expect((thrown as HeadlessError).message).toMatch(/refusing to sign new records/);
      // The refusal happens before the chain is touched.
      expect(ledger.readAll()).toHaveLength(2);
    });
  });

  test("the weak-key refusal names the variable the operator actually set", () => {
    // Regression: the message hardcoded HEADLESS_LEDGER_KEYS, sending an
    // operator who set the singular variable to one they never configured.
    withRoot((root) => {
      const ledger = new LedgerV2({
        ledgerPath: join(root, "ledger.jsonl"),
        readModelPath: join(root, "read.json"),
        projectId: PROJECT_ID,
        principal: "operator",
        ...ledgerIntegrityOptionsFromEnv({ HEADLESS_LEDGER_KEY: WEAK_KEY, HEADLESS_LEDGER_KEY_ID: "solo" }),
      });
      const message = (() => {
        try {
          ledger.append("nope", {});
          return "";
        } catch (error) {
          return (error as Error).message;
        }
      })();
      expect(message).toContain("HEADLESS_LEDGER_KEY)");
      expect(message).toContain("solo");
      expect(message).not.toMatch(/\bHEADLESS_LEDGER_KEYS\b contains/);
    });

    withRoot((root) => {
      const ledger = new LedgerV2({
        ledgerPath: join(root, "ledger.jsonl"),
        readModelPath: join(root, "read.json"),
        projectId: PROJECT_ID,
        principal: "operator",
        ...ledgerIntegrityOptionsFromEnv({
          HEADLESS_LEDGER_KEYS: JSON.stringify({ ring: WEAK_KEY }),
          HEADLESS_LEDGER_ACTIVE_KEY_ID: "ring",
        }),
      });
      const message = (() => {
        try {
          ledger.append("nope", {});
          return "";
        } catch (error) {
          return (error as Error).message;
        }
      })();
      expect(message).toContain("(from HEADLESS_LEDGER_KEYS)");
      expect(message).toContain("ring");
    });
  });

  test("no error or verdict ever carries key material, not even a prefix", () => {
    // Regression: the failure text embedded the key's first four characters and
    // reached the verify verdict, which the CLI prints and operators paste.
    const secret = "abcdefgh-weak-key";
    const prefix = secret.slice(0, 4);
    withRoot((root) => {
      const ledgerPath = join(root, "ledger.jsonl");
      writeLegacyChain(ledgerPath, secret, "leaky");
      const options = ledgerIntegrityOptionsFromEnv({
        HEADLESS_LEDGER_KEY: secret,
        HEADLESS_LEDGER_KEY_ID: "leaky",
      });

      const verdict = verifyLedgerChain({ ledgerPath, projectId: PROJECT_ID, ...options });
      const rendered = JSON.stringify(verdict);
      expect(rendered).not.toContain(secret);
      expect(rendered).not.toContain(prefix);
      expect(verdict.weakKeys?.keyIds).toEqual(["leaky"]);

      const ledger = new LedgerV2({
        ledgerPath,
        readModelPath: join(root, "read.json"),
        projectId: PROJECT_ID,
        principal: "legacy-operator",
        ...options,
      });
      let message = "";
      try {
        ledger.append("nope", {});
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).not.toContain(secret);
      expect(message).not.toContain(prefix);
      expect(message).toContain("leaky");
    });
  });

  test("a weak verification-only key does not block a strong active key", () => {
    // The documented rotation: keep the old key for history, sign with a new one.
    const active = strongKey();
    withRoot((root) => {
      const ledgerPath = join(root, "ledger.jsonl");
      writeLegacyChain(ledgerPath, WEAK_KEY, "legacy");
      const ledger = new LedgerV2({
        ledgerPath,
        readModelPath: join(root, "read.json"),
        projectId: PROJECT_ID,
        principal: "operator",
        ...ledgerIntegrityOptionsFromEnv({
          HEADLESS_LEDGER_KEYS: JSON.stringify({ legacy: WEAK_KEY, primary: active }),
          HEADLESS_LEDGER_ACTIVE_KEY_ID: "primary",
        }),
      });
      const record = ledger.append("rotated", { ok: true });
      expect(record.integrity).toEqual({ algorithm: "hmac-sha256", keyId: "primary" });
      expect(ledger.weakIntegrityKeyIds).toEqual(["legacy"]);

      const verdict = verifyLedgerChain({
        ledgerPath,
        projectId: PROJECT_ID,
        hmacKeyring: { legacy: WEAK_KEY, primary: active },
        activeHmacKeyId: "primary",
      });
      expect(verdict.ok).toBe(true);
      expect(verdict.recordsChecked).toBe(3);
      expect(verdict.weakKeys?.keyIds).toEqual(["legacy"]);
    });
  });

  test("tail repair refuses under a weak active key before it rewrites bytes", () => {
    withRoot((root) => {
      const ledgerPath = join(root, "ledger.jsonl");
      writeLegacyChain(ledgerPath, WEAK_KEY, "legacy");
      writeFileSync(ledgerPath, '{"version":2,"sequence":3', { flag: "a" });
      const before = statSync(ledgerPath).size;

      expect(() =>
        repairLedgerPartialTail({
          ledgerPath,
          readModelPath: join(root, "read.json"),
          projectId: PROJECT_ID,
          principal: "operator",
          ...ledgerIntegrityOptionsFromEnv({ HEADLESS_LEDGER_KEY: WEAK_KEY, HEADLESS_LEDGER_KEY_ID: "legacy" }),
        }),
      ).toThrow(/refusing to sign new records/);
      // The partial tail is still there: nothing was truncated on the way out.
      expect(statSync(ledgerPath).size).toBe(before);
    });
  });

  test("the entropy floor still classifies weak shapes as weak", () => {
    const shapes: Array<[string, string]> = [
      ["repeated", "a".repeat(32)],
      ["digits", "12345678901234567890123456789012"],
      ["password", "passwordpasswordpasswordpassword"],
      ["short", WEAK_KEY],
    ];
    for (const [label, key] of shapes) {
      const verdict = verifyLedgerChain({
        records: [],
        projectId: PROJECT_ID,
        hmacKeyring: { [label]: key },
        activeHmacKeyId: label,
      });
      expect(verdict.weakKeys?.keyIds, label).toEqual([label]);
    }
  });

  test("high-entropy 32+ byte keys are accepted for writing", () => {
    const opensslStyle = strongKey();
    expect(Buffer.from(opensslStyle, "base64").length).toBe(32);

    const fromKeyring = ledgerIntegrityOptionsFromEnv({
      HEADLESS_LEDGER_KEYS: JSON.stringify({ primary: opensslStyle }),
      HEADLESS_LEDGER_ACTIVE_KEY_ID: "primary",
    });
    expect(fromKeyring.hmacKeyring?.primary).toBe(opensslStyle);
    expect(fromKeyring.activeHmacKeyId).toBe("primary");

    const raw = randomBytes(32).toString("hex"); // 64 hex chars
    const fromSingle = ledgerIntegrityOptionsFromEnv({ HEADLESS_LEDGER_KEY: raw, HEADLESS_LEDGER_KEY_ID: "solo" });
    expect(fromSingle.hmacKey).toBe(raw);
    expect(fromSingle.hmacKeyId).toBe("solo");

    withRoot((root) => {
      const ledger = new LedgerV2({
        ledgerPath: join(root, "ledger.jsonl"),
        readModelPath: join(root, "read.json"),
        projectId: PROJECT_ID,
        principal: "test-principal",
        hmacKeyring: { primary: opensslStyle },
        activeHmacKeyId: "primary",
      });
      const record = ledger.append("entropy-ok", { ok: true });
      expect(record.integrity).toEqual({ algorithm: "hmac-sha256", keyId: "primary" });
      expect(ledger.weakIntegrityKeyIds).toEqual([]);

      const verdict = verifyLedgerChain({
        ledgerPath: join(root, "ledger.jsonl"),
        projectId: PROJECT_ID,
        hmacKeyring: { primary: opensslStyle },
        activeHmacKeyId: "primary",
      });
      expect(verdict.ok).toBe(true);
      expect(verdict.weakKeys).toBeUndefined();
    });
  });

  test("unusable key material still fails closed and names its own variable", () => {
    let thrown: unknown;
    try {
      ledgerIntegrityOptionsFromEnv({ HEADLESS_LEDGER_KEYS: "{not json" });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(HeadlessError);
    expect((thrown as HeadlessError).message).toStartWith("HEADLESS_LEDGER_KEYS");

    expect(() => ledgerIntegrityOptionsFromEnv({ HEADLESS_LEDGER_KEYS: JSON.stringify({ primary: "" }) }))
      .toThrow(/HEADLESS_LEDGER_KEYS/);
    expect(() => ledgerIntegrityOptionsFromEnv({ HEADLESS_LEDGER_KEYS: JSON.stringify({ primary: 42 }) }))
      .toThrow(/HEADLESS_LEDGER_KEYS/);
  });

  test("an active key id absent from the keyring is a verdict, not a crash", () => {
    const verdict = verifyLedgerChain({
      records: [],
      projectId: PROJECT_ID,
      hmacKeyring: { legacy: WEAK_KEY },
      activeHmacKeyId: "missing",
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toMatch(/absent from the keyring/);
    expect(JSON.stringify(verdict)).not.toContain(WEAK_KEY.slice(0, 4));
  });
});
