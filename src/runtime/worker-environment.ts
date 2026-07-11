import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordRuntimeDiagnostic } from "./diagnostics";

const PASSTHROUGH_KEYS = new Set([
  "PATH",
  "TERM",
  "COLORTERM",
  "LANG",
  "TZ",
  "NO_COLOR",
]);

export interface WorkerEnvironmentPaths {
  root: string;
  home: string;
  config: string;
  data: string;
  cache: string;
  runtime: string;
  temp: string;
}

export interface WorkerEnvironment extends WorkerEnvironmentPaths {
  env: NodeJS.ProcessEnv;
  cleanup: () => void;
}

export interface WorkerEnvironmentOptions {
  baseDir?: string;
  sourceEnv?: NodeJS.ProcessEnv;
}

export function createWorkerEnvironment(options: WorkerEnvironmentOptions = {}): WorkerEnvironment {
  const baseDir = options.baseDir ?? tmpdir();
  mkdirSync(baseDir, { recursive: true, mode: 0o700 });

  const root = realpathSync.native(mkdtempSync(join(baseDir, "headless-worker-")));
  try {
    const paths = {
      root,
      home: join(root, "home"),
      config: join(root, "config"),
      data: join(root, "data"),
      cache: join(root, "cache"),
      runtime: join(root, "runtime"),
      temp: join(root, "tmp"),
    };

    chmodSync(root, 0o700);
    for (const path of Object.values(paths)) {
      if (path === root) continue;
      mkdirSync(path, { mode: 0o700 });
      chmodSync(path, 0o700);
    }

    let cleaned = false;
    return {
      ...paths,
      env: buildWorkerEnvironment(options.sourceEnv ?? process.env, paths),
      cleanup: () => {
        if (cleaned) return;
        cleaned = true;
        rmSync(root, { recursive: true, force: true });
      },
    };
  } catch (error) {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch (cleanupError) {
      recordRuntimeDiagnostic("cleanup", "worker-environment.creation-rollback", cleanupError);
    }
    throw error;
  }
}

export function buildWorkerEnvironment(
  sourceEnv: NodeJS.ProcessEnv,
  paths: WorkerEnvironmentPaths,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(sourceEnv)) {
    if (!value) continue;
    if (PASSTHROUGH_KEYS.has(key) || key.startsWith("LC_")) env[key] = value;
  }

  return {
    ...env,
    HOME: paths.home,
    XDG_CONFIG_HOME: paths.config,
    XDG_DATA_HOME: paths.data,
    XDG_CACHE_HOME: paths.cache,
    XDG_RUNTIME_DIR: paths.runtime,
    TMPDIR: paths.temp,
    TMP: paths.temp,
    TEMP: paths.temp,
    USER: "headless",
    LOGNAME: "headless",
    // Git worktree metadata is intentionally read-only to workers. Disable
    // opportunistic index refresh/locks and all host Git configuration.
    GIT_OPTIONAL_LOCKS: "0",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
  };
}
