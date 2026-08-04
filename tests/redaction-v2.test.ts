import { describe, expect, test } from "bun:test";
import { redactAndTruncate, StreamingRedactor } from "../src/runtime/redaction";
import { testTimeout } from "./support/timing";

describe("stream-safe redaction", () => {
  test("redacts daemon broker leases without redacting non-secret hls UUID ids", () => {
    const token = `hls_${"A".repeat(43)}`;
    const id = "hls_123e4567-e89b-12d3-a456-426614174000";
    const result = redactAndTruncate(`${id} ${token}`);

    expect(result.text).toContain(id);
    expect(result.text).toContain("[REDACTED_HEADLESS_BROKER_TOKEN]");
    expect(result.text).not.toContain(token);
  });

  test("redacts short-lived run-tool credentials", () => {
    const token = `hlt_${"R".repeat(64)}`;
    const result = redactAndTruncate(`worker printed ${token}`);
    expect(result.text).toContain("[REDACTED_HEADLESS_RUN_TOOL_TOKEN]");
    expect(result.text).not.toContain(token);
  });

  test("redacts Claude setup-tokens with their complete base64url alphabet", () => {
    const token = `sk-ant-oat${"C".repeat(31)}-`;
    const result = redactAndTruncate(`worker printed ${token}`);
    expect(result.text).toContain("[REDACTED_CLAUDE_SETUP_TOKEN]");
    expect(result.text).not.toContain(token);
  });

  test("consumes trailing base64url dashes from daemon-issued credentials", () => {
    const brokerToken = `hls_${"B".repeat(63)}-`;
    const runToolToken = `hlt_${"R".repeat(63)}-`;

    expect(redactAndTruncate(brokerToken)).toEqual({
      text: "[REDACTED_HEADLESS_BROKER_TOKEN]",
      redacted: true,
      truncated: false,
    });
    expect(redactAndTruncate(runToolToken)).toEqual({
      text: "[REDACTED_HEADLESS_RUN_TOOL_TOKEN]",
      redacted: true,
      truncated: false,
    });
  });

  test("does not mistake ordinary secret-domain function calls for credentials", () => {
    const source = [
      "const secret = makeSecret(options);",
      "const secretIndex = encode(secret);",
      "const password = derivePassword(input);",
    ].join("\n");
    const result = redactAndTruncate(source);

    expect(result.redacted).toBe(false);
    expect(result.text).toBe(source);
    expect(redactAndTruncate(`api_key=${"f".repeat(40)}`).redacted).toBe(true);
    expect(redactAndTruncate('api_key="makeSecret(options)"').text).toContain('[REDACTED]');
    expect(redactAndTruncate("password='derivePassword(input)'").text).toContain('[REDACTED]');
  });

  /**
   * A triggered redaction rejects the entire write candidate
   * (write-integration.ts), so a false positive here is not cosmetic: it means
   * an agent cannot write that code at all, and the diff a human reviews comes
   * back corrupted. This was found by a real agent whose duration parser was
   * rejected for naming a variable `tokenPattern`.
   */
  test("does not mangle code that merely names a variable after a credential word", () => {
    const source = [
      String.raw`const tokenPattern = /(\d+)(ms|s|m|h|d)/gy;`,
      "const secretSantaList = participants.map((p) => p.name);",
      "const authHandlers = registry.resolve(scope).handlers;",
      "const accessConfig = {enabled: true};",
      "const apiTemplate = `${base}/v1/resource`;",
    ].join("\n");
    const result = redactAndTruncate(source);
    expect(result.redacted).toBe(false);
    expect(result.text).toBe(source);
  });

  test("still redacts real credentials assigned to the same keyword names", () => {
    for (const secret of [
      `tokenValue=${"a".repeat(40)}`,
      `access_token=${"b".repeat(40)}`,
      `authorization=${"c".repeat(40)}`,
      `apiSecret=${"d".repeat(32)}`,
    ]) {
      const result = redactAndTruncate(secret);
      expect(result.redacted, secret).toBe(true);
      expect(result.text, secret).toContain("[REDACTED]");
    }
  });

  /**
   * The quoted form stays deliberately aggressive. A string literal assigned to
   * an auth-named field is exactly the shape a leaked credential takes, so it
   * keeps redacting even when the contents look harmless. That is a knowingly
   * accepted false-positive cost in exchange for no false negatives.
   */
  test("keeps redacting quoted values assigned to credential-named fields", () => {
    expect(redactAndTruncate(`const authHeaderName = "x-request-id";`).redacted).toBe(true);
    expect(redactAndTruncate('api_key="makeSecret(options)"').redacted).toBe(true);
  });

  test("does not reject ordinary storage constants or React key props", () => {
    const source = [
      "const STORAGE_KEY = 'signal-garden:intentions'",
      "const row = <Plant key={item.id} intention={item} />",
    ].join("\n");
    expect(redactAndTruncate(source)).toEqual({ text: source, redacted: false, truncated: false });
    expect(redactAndTruncate(`OPENAI_API_KEY=${"z".repeat(40)}`).redacted).toBe(true);
    expect(redactAndTruncate(`SECRET_KEY=${"y".repeat(40)}`).redacted).toBe(true);
  });

  test("cannot reconstruct secrets split at arbitrary chunk boundaries", () => {
    const secrets = [
      `hls_${"B".repeat(43)}`,
      `hls_${"B".repeat(63)}-`,
      `hlt_${"R".repeat(64)}`,
      `hlt_${"R".repeat(63)}-`,
      `sk-${"c".repeat(32)}`,
      `sk-ant-oat${"c".repeat(31)}-`,
      `anthropic-${"d".repeat(32)}`,
      `Bearer ${"e".repeat(40)}`,
      `api_key=${"f".repeat(40)}`,
    ];

    for (const secret of secrets) {
      const input = `${"safe-prefix ".repeat(30)}${secret}\nplain suffix`;
      for (let split = 1; split < input.length; split += 1) {
        const emitted: string[] = [];
        const stream = new StreamingRedactor((chunk) => emitted.push(chunk), 256);
        stream.push(input.slice(0, split));
        stream.push(input.slice(split));
        stream.finish();
        const output = emitted.join("");
        expect(output).not.toContain(secret);
        expect(output).toContain("plain suffix");
      }
    }
    // ~1.3s unloaded, but every secret is re-scanned at every split offset, so a
    // loaded suite pushes it past Bun's 5s default and reports a timeout that
    // reads exactly like a redaction regression.
  }, testTimeout(30_000));

  test("preserves non-secret stream text and fails closed when redaction fails", () => {
    const normal: string[] = [];
    const stream = new StreamingRedactor((chunk) => normal.push(chunk), 256);
    stream.push("alpha ");
    stream.push("beta ".repeat(100));
    stream.push("omega");
    stream.finish();
    expect(normal.join("")).toBe(`alpha ${"beta ".repeat(100)}omega`);

    const failed: string[] = [];
    const broken = new StreamingRedactor(
      (chunk) => failed.push(chunk),
      256,
      () => { throw new Error("raw-secret-must-not-escape"); },
    );
    broken.push("x".repeat(300));
    broken.push("raw-secret-must-not-escape");
    broken.finish();
    expect(failed.join("")).toBe("[SUPPRESSED: REDACTION FAILURE]");
  });

  test("holds an unterminated private key beyond the nominal overlap", () => {
    const key = `-----BEGIN PRIVATE KEY-----\n${"A".repeat(2_000)}\n-----END PRIVATE KEY-----`;
    const input = `${"prefix".repeat(100)}${key}\nsuffix`;
    const output: string[] = [];
    const stream = new StreamingRedactor((chunk) => output.push(chunk), 256);
    for (let offset = 0; offset < input.length; offset += 17) stream.push(input.slice(offset, offset + 17));
    stream.finish();

    expect(output.join("")).not.toContain("A".repeat(100));
    expect(output.join("")).toContain("[REDACTED_PRIVATE_KEY]");
    expect(output.join("")).toContain("suffix");
  });
});
