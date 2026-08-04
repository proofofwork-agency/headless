import { lstatSync, rmSync } from "node:fs";
import type { Server } from "node:net";
import { HeadlessError } from "./headless-error";

/** Bind-time umask: strips every group/other bit from the socket at creation. */
const SECURE_UMASK = 0o077;

/**
 * Assert a Unix socket filesystem entry is owner-only before the caller treats
 * the bind as live. Used to close the chmod-after-listen TOCTOU window: the
 * umask guard around the bind makes the socket owner-only at creation, and this
 * lstat is the fail-closed verification gate (foreign uid or any group/other
 * bit ⇒ refuse to start instead of accepting the first frame on an exposed socket).
 */
export function assertSecureSocket(socketPath: string): void {
  // Fail closed when the platform cannot report a uid. The uid comparison is the
  // only thing distinguishing our socket from a foreign-owned substitution, so an
  // unverifiable platform must refuse the socket rather than skip the check (this
  // is deliberately stricter than assertTrustedAncestorChain, which tolerates a
  // missing getuid because it still has mode bits to fall back on).
  if (typeof process.getuid !== "function") {
    throw new HeadlessError(
      "INTERNAL_ERROR",
      `Secure socket verification failed: process.getuid is unavailable on this platform, so ownership of ${socketPath} cannot be verified.`,
    );
  }
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

/** Which inode a socket path named at a known moment (dev+ino, exact via bigint). */
export type BoundSocketIdentity = { readonly dev: bigint; readonly ino: bigint };

/**
 * Snapshot the inode a socket path currently names.
 *
 * Null means "nothing is there", which every caller treats as holding no claim
 * on the path — a later removal then stays a no-op instead of a blind delete.
 */
export function captureSocketIdentity(socketPath: string): BoundSocketIdentity | null {
  try {
    const info = lstatSync(socketPath, { bigint: true });
    return { dev: info.dev, ino: info.ino };
  } catch {
    return null;
  }
}

/**
 * Unlink socketPath only while it still names the inode recorded in `identity`.
 *
 * Both runtimes unlink a bound path from inside close()/stop() — verified on Bun
 * 1.3.14 for node:net and Bun.serve alike — so a teardown's path is already free
 * before its close callback even fires. An unconditional rmSync after that point
 * deletes whatever bound the path in the window instead of the caller's own
 * socket. The daemon socket path is deterministic per project and the daemon
 * auto-stops when idle, so the reachable case needs no attacker: a CLI
 * invocation arriving during idle shutdown starts a replacement daemon that
 * binds and is then unlinked by the departing one, leaving a running but
 * unreachable daemon. The same shape lets a daemon that lost a startup election
 * delete the winner's live socket after its staleness probe came back "dead".
 *
 * Comparing dev+ino keeps a removal scoped to the exact entry the caller proved
 * it owns. Returns true only when this call removed that entry.
 */
export function removeOwnedSocket(socketPath: string, identity: BoundSocketIdentity | null): boolean {
  if (!identity) return false;
  const current = captureSocketIdentity(socketPath);
  if (!current || current.dev !== identity.dev || current.ino !== identity.ino) return false;
  rmSync(socketPath, { force: true });
  return true;
}

/**
 * process.umask() is process-global, so a naive save/set/restore pair is unsafe
 * the moment two binds overlap: each captures the other's temporary 0o077 as its
 * "previous" value and restores that instead of the real baseline, permanently
 * leaving the process at 0o077. Reference-count the window instead — the first
 * entrant records the true baseline, the last leaver restores it exactly once —
 * so the synchronous Bun path can safely nest inside an in-flight async bind.
 */
let umaskDepth = 0;
let umaskBaseline = 0;

function enterSecureUmask(): void {
  const previous = process.umask(SECURE_UMASK);
  if (umaskDepth === 0) umaskBaseline = previous;
  umaskDepth += 1;
}

function exitSecureUmask(): void {
  // Never restore a baseline we do not own: an unbalanced exit would hand the
  // process a stale umask belonging to some earlier window.
  if (umaskDepth === 0) return;
  umaskDepth -= 1;
  if (umaskDepth === 0) process.umask(umaskBaseline);
}

/**
 * Serializes await-spanning secure binds. Reference counting already keeps the
 * restore correct, but every unrelated file created anywhere in the process
 * inherits 0o077 while the window is open — serializing keeps that window one
 * bind wide instead of the union of all concurrent binds.
 */
let secureBindQueue: Promise<unknown> = Promise.resolve();

function withSecureBindLock<T>(task: () => Promise<T>): Promise<T> {
  const result = secureBindQueue.then(task);
  // A failed bind must not poison the queue for later binds.
  secureBindQueue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

/**
 * Bind a node:net Server to a Unix socket with umask 0o077 active during the
 * bind, then verify the resulting socket is owner-only before resolving. The
 * umask is always restored (even on failure). Replaces the listen-then-chmod
 * TOCTOU pattern.
 *
 * This helper deliberately does NOT unlink a pre-existing entry at socketPath.
 * bind(2) fails with EADDRINUSE whenever the path already exists — live or
 * stale — and that kernel refusal is the backstop that makes every caller's
 * check-then-bind single-owner election safe. Distinguishing a live owner from
 * a crashed one is caller policy (HeadlessDaemon.start probes for liveness and
 * unlinks only a stale socket; the broker and run-tool endpoints simply refuse
 * an existing path), so clearing the path here would silently defeat all three.
 */
export async function secureUnixListen(server: Server, socketPath: string): Promise<void> {
  return withSecureBindLock(async () => {
    enterSecureUmask();
    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error) => {
          server.off("listening", onListening);
          reject(error);
        };
        const onListening = () => {
          server.off("error", onError);
          resolve();
        };
        server.once("error", onError);
        server.once("listening", onListening);
        server.listen(socketPath);
      });
      // Fail-closed verification gate: even though umask 0o077 was active during
      // bind, verify the on-disk mode/owner before returning. A platform that
      // ignored the umask (or a pre-seeded substitution) is refused here rather
      // than exposing the socket while we chmod-after-the-fact. The caller owns
      // the Server instance and closes it on a rejection (which unlinks the
      // path), so unlike secureBunUnixServe there is no listener to dispose here.
      assertSecureSocket(socketPath);
    } finally {
      exitSecureUmask();
    }
  });
}

/**
 * Wrap Bun.serve({ unix }) with the same umask guard + post-bind verification,
 * and the same no-unlink exclusivity contract as secureUnixListen. Bun's serve
 * is synchronous for unix binds on the current runtime, so no await spans the
 * umask window here; the reference-counted scope keeps it correct when it lands
 * inside an in-flight secureUnixListen window. Returns whatever Bun.serve
 * produced so callers can assign it directly.
 */
export function secureBunUnixServe<T>(socketPath: string, factory: () => T): T {
  enterSecureUmask();
  let server: T | undefined;
  try {
    server = factory();
    assertSecureSocket(socketPath);
    return server;
  } catch (error) {
    // The listener exists but was refused, and the caller never receives the
    // handle — this is the only place that can stop it. Leaving it running would
    // keep the refused socket accepting frames, defeating the fail-closed gate.
    stopRefusedServer(server);
    throw error;
  } finally {
    exitSecureUmask();
  }
}

/** Best-effort stop for a server we created and then refused. */
function stopRefusedServer(server: unknown): void {
  const stop = (server as { stop?: unknown } | undefined)?.stop;
  if (typeof stop !== "function") return;
  try {
    (stop as (closeActiveConnections?: boolean) => void).call(server, true);
  } catch {
    // The refusal is already fatal; a failed stop must not mask it.
  }
}
