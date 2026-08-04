import { lstatSync, rmSync } from "node:fs";
import type { Server } from "node:net";
import { HeadlessError } from "./headless-error";

/**
 * Assert a Unix socket filesystem entry is owner-only before the caller treats
 * the bind as live. Used to close the chmod-after-listen TOCTOU window: the
 * umask guard around the bind makes the socket owner-only at creation, and this
 * lstat is the fail-closed verification gate (foreign uid or any group/other
 * bit ⇒ refuse to start instead of accepting the first frame on an exposed socket).
 */
export function assertSecureSocket(socketPath: string): void {
  let info;
  try {
    info = lstatSync(socketPath);
  } catch (error) {
    throw new HeadlessError(
      "INTERNAL_ERROR",
      `Secure socket verification failed: unable to stat ${socketPath} (${(error as Error).message}).`,
    );
  }
  if (!info.isSocket()) {
    throw new HeadlessError(
      "INTERNAL_ERROR",
      `Secure socket verification failed: ${socketPath} is not a Unix socket.`,
    );
  }
  const mode = info.mode & 0o777;
  if ((mode & 0o077) !== 0) {
    throw new HeadlessError(
      "INTERNAL_ERROR",
      `Secure socket verification failed: ${socketPath} has permissive mode 0o${mode.toString(8)} (group/other bits present); refusing to accept on an exposed socket.`,
    );
  }
  const expectedUid = process.getuid();
  if (info.uid !== expectedUid) {
    throw new HeadlessError(
      "INTERNAL_ERROR",
      `Secure socket verification failed: ${socketPath} is owned by uid ${info.uid}, expected uid ${expectedUid}; refusing to use a foreign-owned trust root.`,
    );
  }
}

/**
 * Bind a node:net Server to a Unix socket with umask 0o077 active during the
 * bind, then verify the resulting socket is owner-only before resolving. The
 * umask is always restored (even on failure). Any pre-existing socket entry is
 * removed before the bind. Replaces the listen-then-chmod TOCTOU pattern.
 */
export async function secureUnixListen(server: Server, socketPath: string): Promise<void> {
  rmSync(socketPath, { force: true });
  const previousUmask = process.umask(0o077);
  let listening = false;
  try {
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => {
        server.off("listening", onListening);
        reject(error);
      };
      const onListening = () => {
        server.off("error", onError);
        listening = true;
        resolve();
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(socketPath);
    });
    // Fail-closed verification gate: even though umask 0o077 was active during
    // bind, verify the on-disk mode/owner before returning. A platform that
    // ignored the umask (or a pre-seeded substitution) is refused here rather
    // than exposing the socket while we chmod-after-the-fact.
    assertSecureSocket(socketPath);
  } finally {
    process.umask(previousUmask);
  }
  // Defensive: if verification passed but a later caller path expects the file
  // gone on failure, listening===true is the only path that reaches here.
  void listening;
}

/**
 * Wrap Bun.serve({ unix }) with the same umask guard + post-bind verification.
 * Bun's serve is synchronous for unix binds on the current runtime, so the
 * umask is set before the call and restored after; the verification lstat runs
 * before the caller treats the server as ready. Returns whatever Bun.serve
 * produced so callers can assign it directly.
 */
export function secureBunUnixServe<T>(socketPath: string, factory: () => T): T {
  rmSync(socketPath, { force: true });
  const previousUmask = process.umask(0o077);
  try {
    const server = factory();
    assertSecureSocket(socketPath);
    return server;
  } finally {
    process.umask(previousUmask);
  }
}
