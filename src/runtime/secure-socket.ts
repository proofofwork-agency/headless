import { lstatSync } from "node:fs";
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

/**
 * Both runtimes unlink a bound path from inside close()/stop(), so a caller has
 * nothing left to clean up after a teardown and must not try.
 *
 * Measured on Bun 1.3.14, macOS and Linux/ext4: after an awaited node:net
 * close(), a synchronous Bun.serve().stop(true), and a synchronous
 * Bun.listen().stop(true), the path was already absent — 1,000/1,000 iterations
 * per runtime on Linux, immediately and after a tick.
 *
 * A post-close unlink therefore has no legitimate work available to it: by the
 * time it runs, anything at that path was bound by somebody else. That is not
 * hypothetical — the daemon socket path is deterministic per project and the
 * daemon auto-stops when idle, so a CLI invocation arriving during idle
 * shutdown starts a replacement daemon whose socket the departing one would
 * delete, leaving a running but unreachable daemon.
 *
 * An earlier attempt guarded the unlink by comparing the path's dev+ino against
 * the value recorded at bind. That does not work: on ext4 an immediate
 * successor reused the freed inode number in 20,000/20,000 trials, and adding
 * ctimeNs did not separate them in 19,825 of those, because the filesystem
 * clock collides inside the same millisecond. Filesystem identity is not a
 * correctness primitive here, so there is no cleanup to guard — only one to
 * delete.
 */

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
