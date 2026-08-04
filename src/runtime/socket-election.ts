import { Database } from "bun:sqlite";
import { closeSync, openSync } from "node:fs";
import { dirname } from "node:path";
import { HeadlessError } from "./headless-error";
import {
  ensureOwnerOnlyDirectory,
  ensureOwnerOnlyFile,
  OWNER_ONLY_FILE_MODE,
} from "./project-state";

const ELECTION_DATABASE_SUFFIX = ".election.sqlite";

export type SocketElectionOptions = {
  busyMessage: string;
};

/** One persistent lock database is shared by every owner of a project socket. */
export function socketElectionDatabasePath(socketPath: string) {
  return `${socketPath}${ELECTION_DATABASE_SUFFIX}`;
}

/**
 * Serialize the stale-probe -> unlink -> bind sequence across processes.
 *
 * The database is deliberately persistent. Headless creates it once and never
 * deletes or recreates it: replacing the file would split contenders across
 * different inodes and destroy the lock's single-owner guarantee. SQLite owns
 * crash recovery for the exclusive transaction, so process death releases the
 * election without a PID or age heuristic.
 */
export async function withSocketElection<T>(
  socketPath: string,
  options: SocketElectionOptions,
  operation: () => T | Promise<T>,
): Promise<T> {
  const database = acquireSocketElection(socketPath, options);
  try {
    return await operation();
  } finally {
    releaseSocketElection(database);
  }
}

function acquireSocketElection(socketPath: string, options: SocketElectionOptions) {
  const path = socketElectionDatabasePath(socketPath);
  let database: Database | null = null;
  try {
    ensureOwnerOnlyDirectory(dirname(path));
    createElectionDatabaseOnce(path);
    ensureOwnerOnlyFile(path);
    database = new Database(path, { strict: true });
    database.exec("PRAGMA busy_timeout=0");
    database.exec("BEGIN EXCLUSIVE");
    const checked = database.query<{ quick_check: string }, []>("PRAGMA quick_check(1)").get();
    if (checked?.quick_check !== "ok") throw new Error("Socket election database failed its integrity check.");
    return database;
  } catch (error) {
    database?.close(false);
    if (isSqliteBusy(error)) {
      throw new HeadlessError("DAEMON_ALREADY_RUNNING", options.busyMessage, {
        retryable: true,
        cause: error,
      });
    }
    throw new HeadlessError(
      "INTERNAL_ERROR",
      "Headless could not verify the project socket election lock; refusing to modify the socket path.",
      { cause: error },
    );
  }
}

function createElectionDatabaseOnce(path: string) {
  let descriptor: number | null = null;
  try {
    descriptor = openSync(path, "wx", OWNER_ONLY_FILE_MODE);
  } catch (error) {
    if (!isAlreadyExists(error)) throw error;
  } finally {
    // close(2) releases the descriptor even when it reports an error. Attempt
    // it exactly once; retrying could close an unrelated, reused descriptor.
    if (descriptor !== null) closeSync(descriptor);
  }
}

function releaseSocketElection(database: Database) {
  try {
    database.exec("ROLLBACK");
  } catch (error) {
    throw new HeadlessError(
      "INTERNAL_ERROR",
      "Headless could not release the project socket election lock cleanly.",
      { cause: error },
    );
  } finally {
    database.close(false);
  }
}

function isSqliteBusy(error: unknown) {
  return !!error
    && typeof error === "object"
    && "code" in error
    && error.code === "SQLITE_BUSY"
    && "errno" in error
    && error.errno === 5;
}

function isAlreadyExists(error: unknown) {
  return !!error && typeof error === "object" && "code" in error && error.code === "EEXIST";
}
