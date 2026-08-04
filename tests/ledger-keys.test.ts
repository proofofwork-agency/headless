import { describe, expect, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HeadlessError } from "../src/runtime/headless-error";
import { LedgerV2, ledgerIntegrityOptionsFromEnv } from "../src/runtime/ledger-v2";

describe("ledger HMAC key entropy floor", () => {
  test("rejects HEADLESS_LEDGER_KEYS entries shorter than 32 characters", () => {
    const shortKey = "sixteen-char-key"; // 16 chars — former floor
    expect(shortKey.length).toBe(16);
    let thrown: unknown;
    try {
      ledgerIntegrityOptionsFromEnv({
        HEADLESS_LEDGER_KEYS: JSON.stringify({ primary: shortKey }),
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(HeadlessError);
    const message = (thrown as HeadlessError).message;
    expect(message).toMatch(/shorter than 32 bytes|below entropy floor/i);
    expect(message).toMatch(/openssl rand -base64 32/);
    expect(message).not.toContain(shortKey);
  });

  test("rejects low-entropy keys even when length is ≥32", () => {
    const repeated = "a".repeat(32);
    let thrown: unknown;
    try {
      ledgerIntegrityOptionsFromEnv({
        HEADLESS_LEDGER_KEYS: JSON.stringify({ primary: repeated }),
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(HeadlessError);
    const message = (thrown as HeadlessError).message;
    expect(message).toMatch(/below entropy floor|shorter than 32 bytes/i);
    expect(message).not.toContain(repeated);
    // Redaction may show a short prefix; never the full secret.
    expect(message).not.toMatch(/a{8,}/);

    const digits = "12345678901234567890123456789012";
    expect(() =>
      ledgerIntegrityOptionsFromEnv({
        HEADLESS_LEDGER_KEYS: JSON.stringify({ primary: digits }),
      }),
    ).toThrow(HeadlessError);

    expect(() =>
      ledgerIntegrityOptionsFromEnv({
        HEADLESS_LEDGER_KEY: "passwordpasswordpasswordpassword",
      }),
    ).toThrow(/openssl rand -base64 32/);
  });

  test("accepts openssl rand -base64 32 output and other high-entropy 32+ byte keys", () => {
    const opensslStyle = randomBytes(32).toString("base64");
    expect(Buffer.from(opensslStyle, "base64").length).toBe(32);

    const fromKeyring = ledgerIntegrityOptionsFromEnv({
      HEADLESS_LEDGER_KEYS: JSON.stringify({ primary: opensslStyle }),
      HEADLESS_LEDGER_ACTIVE_KEY_ID: "primary",
    });
    expect(fromKeyring.hmacKeyring?.primary).toBe(opensslStyle);
    expect(fromKeyring.activeHmacKeyId).toBe("primary");

    const raw = randomBytes(32).toString("hex"); // 64 hex chars
    const fromSingle = ledgerIntegrityOptionsFromEnv({
      HEADLESS_LEDGER_KEY: raw,
      HEADLESS_LEDGER_KEY_ID: "solo",
    });
    expect(fromSingle.hmacKey).toBe(raw);
    expect(fromSingle.hmacKeyId).toBe("solo");

    const root = mkdtempSync(join(tmpdir(), "headless-ledger-keys-"));
    try {
      const projectId = createHash("sha256").update("ledger-keys").digest("hex");
      const ledger = new LedgerV2({
        ledgerPath: join(root, "ledger.jsonl"),
        readModelPath: join(root, "read.json"),
        projectId,
        principal: "test-principal",
        hmacKeyring: { primary: opensslStyle },
        activeHmacKeyId: "primary",
      });
      const record = ledger.append("entropy-ok", { ok: true });
      expect(record.integrity).toEqual({ algorithm: "hmac-sha256", keyId: "primary" });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("error path never echoes the full key value", () => {
    const secret = `weak-but-long-secret-value-XXXX-${"z".repeat(8)}`;
    expect(secret.length).toBeGreaterThanOrEqual(32);
    // Force low entropy via repeated trailing chars / limited charset path:
    const low = "b".repeat(40);
    try {
      ledgerIntegrityOptionsFromEnv({
        HEADLESS_LEDGER_KEYS: JSON.stringify({ k: low }),
      });
      throw new Error("expected throw");
    } catch (error) {
      expect(error).toBeInstanceOf(HeadlessError);
      const message = String((error as Error).message);
      expect(message).not.toContain(low);
      expect(message).not.toContain("bbbbbbbb");
      // At most a 4-char redacted preview may appear in nested causes; top-level env error is generic.
      expect(message).toBe(
        "HEADLESS_LEDGER_KEYS contains a key shorter than 32 bytes / below entropy floor — refusing to start with a weak tamper-evidence key. Generate with: openssl rand -base64 32",
      );
    }
  });

  test("constructor rejects weak keyring material fail-closed", () => {
    const root = mkdtempSync(join(tmpdir(), "headless-ledger-keys-ctor-"));
    try {
      const projectId = createHash("sha256").update("ledger-keys-ctor").digest("hex");
      expect(() =>
        new LedgerV2({
          ledgerPath: join(root, "ledger.jsonl"),
          readModelPath: join(root, "read.json"),
          projectId,
          principal: "test-principal",
          hmacKeyring: { primary: "a".repeat(32) },
          activeHmacKeyId: "primary",
        }),
      ).toThrow(/entropy floor|32 bytes/i);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
