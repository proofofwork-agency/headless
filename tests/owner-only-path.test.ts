import { afterEach, describe, expect, spyOn, test } from "bun:test";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  OWNER_ONLY_DIRECTORY_MODE,
  OWNER_ONLY_FILE_MODE,
  ensureOwnerOnlyDirectory,
  ensureOwnerOnlyFile,
} from "../src/runtime/project-state";
import { assertTrustedAncestorChain } from "../src/runtime/trusted-path";
import * as trustedPath from "../src/runtime/trusted-path";

const temporaryPaths: string[] = [];

afterEach(() => {
  for (const path of temporaryPaths.splice(0)) {
    try {
      chmodSync(path, 0o700);
    } catch {
      // best-effort so cleanup can remove group-writable fixtures
    }
    rmSync(path, { recursive: true, force: true });
  }
});

describe("owner-only path trust", () => {
  test("self-owned 0o700 directory passes and ends with (mode & 0o077)===0", () => {
    const fixture = temporaryDirectory("headless-owner-only-ok-");
    // Ensure ancestor chain is owner-only (tmpdir itself may be sticky root).
    chmodSync(fixture, 0o700);
    const directory = join(fixture, "state");

    expect(ensureOwnerOnlyDirectory(directory)).toBe(directory);
    const info = lstatSync(directory);
    expect(info.isDirectory()).toBe(true);
    expect(info.isSymbolicLink()).toBe(false);
    expect(info.uid).toBe(process.getuid!());
    expect(info.mode & 0o777).toBe(OWNER_ONLY_DIRECTORY_MODE);
    expect(info.mode & 0o077).toBe(0);
  });

  test("self-owned file is tightened to 0o600 and re-verified", () => {
    const fixture = temporaryDirectory("headless-owner-only-file-");
    chmodSync(fixture, 0o700);
    const file = join(fixture, "token");
    writeFileSync(file, "secret\n", { mode: 0o666 });
    chmodSync(file, 0o666);

    expect(ensureOwnerOnlyFile(file)).toBe(file);
    const info = lstatSync(file);
    expect(info.isFile()).toBe(true);
    expect(info.mode & 0o777).toBe(OWNER_ONLY_FILE_MODE);
    expect(info.mode & 0o077).toBe(0);
  });

  test("rejects a symlink at the directory leaf", () => {
    const fixture = temporaryDirectory("headless-owner-only-dirlink-");
    chmodSync(fixture, 0o700);
    const target = join(fixture, "real");
    const link = join(fixture, "link");
    mkdirSync(target, { mode: 0o700 });
    symlinkSync(target, link);

    expect(() => ensureOwnerOnlyDirectory(link)).toThrow(/not a directory|refusing to use untrusted/);
  });

  test("rejects a symlink at the file leaf", () => {
    const fixture = temporaryDirectory("headless-owner-only-filelink-");
    chmodSync(fixture, 0o700);
    const target = join(fixture, "real-token");
    const link = join(fixture, "token-link");
    writeFileSync(target, "secret\n", { mode: 0o600 });
    symlinkSync(target, link);

    expect(() => ensureOwnerOnlyFile(link)).toThrow("not a regular file");
  });

  test("rejects a group-writable ancestor", () => {
    const fixture = temporaryDirectory("headless-owner-only-gw-");
    chmodSync(fixture, 0o700);
    const ancestor = join(fixture, "group-writable");
    const leaf = join(ancestor, "leaf");
    mkdirSync(ancestor, { recursive: true, mode: 0o770 });
    chmodSync(ancestor, 0o770);

    expect(() => ensureOwnerOnlyDirectory(leaf)).toThrow(/ancestor must not be writable by group or other/);
  });

  test("rejects foreign-uid leaf without auto-repair", () => {
    if (typeof process.getuid !== "function") return;

    const fixture = temporaryDirectory("headless-owner-only-uid-");
    chmodSync(fixture, 0o700);
    const directory = join(fixture, "foreign");
    mkdirSync(directory, { mode: 0o700 });
    const ownerUid = process.getuid();
    // Simulate a different effective uid than the leaf owner (confused-deputy).
    const foreignUid = ownerUid + 1;
    const getuidSpy = spyOn(process, "getuid").mockReturnValue(foreignUid);

    try {
      expect(() => ensureOwnerOnlyDirectory(directory)).toThrow(
        `path ${directory} is not owned by current uid ${foreignUid} (owner ${ownerUid}) — refusing to use untrusted trust root`,
      );
      // Still owned by the real creator — we must not chown/chmod past failure
      // in a way that claims the path is trusted for the foreign uid.
      expect(lstatSync(directory).uid).toBe(ownerUid);
    } finally {
      getuidSpy.mockRestore();
    }
  });

  test("assertTrustedAncestorChain is the shared predicate used by ensureOwnerOnly*", () => {
    const fixture = temporaryDirectory("headless-owner-only-shared-");
    chmodSync(fixture, 0o700);
    const directory = join(fixture, "shared");

    const spy = spyOn(trustedPath, "assertTrustedAncestorChain");
    ensureOwnerOnlyDirectory(directory);
    expect(spy).toHaveBeenCalled();
    // Caller realpaths the leaf (macOS /var → /private/var) before the shared walk.
    expect(spy.mock.calls.length).toBeGreaterThan(0);
    spy.mockRestore();

    // Direct export still works once the path is physically resolved.
    expect(() => assertTrustedAncestorChain(realpathSync(directory), "test")).not.toThrow();
  });

  test("mode re-verification after chmod guarantees (mode & 0o077)===0", () => {
    const fixture = temporaryDirectory("headless-owner-only-reverify-");
    chmodSync(fixture, 0o700);
    const directory = join(fixture, "reverify");
    mkdirSync(directory, { mode: 0o777 });
    chmodSync(directory, 0o777);

    ensureOwnerOnlyDirectory(directory);
    const after = lstatSync(directory);
    expect(after.mode & 0o077).toBe(0);
    expect(after.mode & 0o777).toBe(OWNER_ONLY_DIRECTORY_MODE);
  });
});

function temporaryDirectory(prefix: string) {
  const path = mkdtempSync(join(tmpdir(), prefix));
  temporaryPaths.push(path);
  return path;
}
