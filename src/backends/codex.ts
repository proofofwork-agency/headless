import { existsSync, lstatSync, readdirSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import type { ExecOptions } from "../index";
import { safeOption } from "../runtime/validation";

const MAX_DISCOVERED_SKILLS = 128;
const MAX_SKILL_SCAN_DEPTH = 8;
const DISABLED_CODEX_FEATURES = [
  "apps",
  "browser_use",
  "browser_use_external",
  "browser_use_full_cdp_access",
  "code_mode_host",
  "computer_use",
  "hooks",
  "image_generation",
  "in_app_browser",
  "multi_agent",
  "plugin_hooks",
  "plugin_sharing",
  "plugins",
  "remote_plugin",
  "skill_mcp_dependency_install",
  "tool_call_mcp_elicitation",
] as const;

/**
 * Prepare Codex with an empty isolated CODEX_HOME (supplied by the runner), an
 * explicitly untrusted project, no repository instructions, no web/apps, and
 * every discoverable repository skill disabled. Native sandboxing is defense
 * in depth beneath Headless' outer containment.
 */
export function buildCodexCommand(opts: ExecOptions, cwd: string) {
  // Headless's outer OS sandbox is the filesystem/network authority. Nested
  // macOS Seatbelt profiles cannot be applied from inside that sandbox, so a
  // required-contained Codex process delegates to the outer profile on Darwin.
  // Linux and explicit unsafe runs retain Codex's mode-specific sandbox.
  const nativeSandbox = opts.mode === "write" ? "workspace-write" : "read-only";
  const sandbox = opts.containment !== "unsafe" && process.platform === "darwin"
    ? "danger-full-access"
    : nativeSandbox;
  const cmd = [
    "codex",
    "exec",
    "--json",
    "--sandbox",
    sandbox,
    "--cd",
    cwd,
    "--skip-git-repo-check",
    "--ignore-user-config",
    "--ignore-rules",
    "--ephemeral",
    "--strict-config",
    ...codexProjectPolicyArguments(cwd),
  ];
  if (opts.approvalPolicy === "bypass") {
    cmd.push("--dangerously-bypass-approvals-and-sandbox");
  } else {
    cmd.push("-c", `approval_policy=${JSON.stringify(opts.approvalPolicy === "auto" ? "never" : "on-request")}`);
  }
  if (opts.model) cmd.push("--model", safeOption(opts.model, "model", { namespace: "Codex" }));
  cmd.push("-");
  return cmd;
}

/** Bounded, deterministic discovery matching Codex' repository skill roots. */
export function discoverRepositorySkills(cwd: string) {
  const root = repositoryRoot(cwd);
  const directories: string[] = [];
  let current = realpathOrInput(cwd);
  while (true) {
    directories.push(current);
    if (current === root) break;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }

  const skills = new Set<string>();
  for (const directory of directories) {
    const roots = [join(directory, ".agents", "skills"), join(directory, ".codex", "skills")];
    for (const skillRoot of roots) {
      assertContainedSkillRoot(skillRoot, root);
      scanSkillRoot(skillRoot, skills, 0, new Set());
    }
    if (skills.size > MAX_DISCOVERED_SKILLS) break;
  }
  if (skills.size > MAX_DISCOVERED_SKILLS) {
    throw new Error(`Refusing Codex startup: project exposes more than ${MAX_DISCOVERED_SKILLS} repository skills.`);
  }
  return [...skills].sort();
}

/** Exact config override shared by one-shot, resume, and app-server drivers. */
export function codexRepositorySkillArguments(cwd: string) {
  const skills = discoverRepositorySkills(cwd);
  return skills.length === 0
    ? []
    : ["-c", `skills.config=[${skills.map((path) => `{path=${JSON.stringify(path)},enabled=false}`).join(",")}]`];
}

/** Shared fail-closed policy for one-shot, resume, and app-server transports. */
export function codexProjectPolicyArguments(cwd: string) {
  return [
    "-c", `${tomlProjectKey(cwd)}.trust_level="untrusted"`,
    "-c", "project_doc_max_bytes=0",
    "-c", "project_doc_fallback_filenames=[]",
    "-c", 'web_search="disabled"',
    "-c", "tools.web_search=false",
    "-c", "apps._default.enabled=false",
    ...DISABLED_CODEX_FEATURES.flatMap((feature) => ["-c", `features.${feature}=false`]),
    ...codexRepositorySkillArguments(cwd),
  ];
}

function assertContainedSkillRoot(path: string, repositoryRoot: string) {
  if (!existsSync(path)) return;
  const relativePath = relative(repositoryRoot, path);
  if (isOutside(relativePath)) {
    throw new Error("Refusing Codex startup: repository skill paths escape the repository root.");
  }
  let current = repositoryRoot;
  for (const segment of relativePath.split(sep).filter(Boolean)) {
    current = join(current, segment);
    let stat;
    try {
      stat = lstatSync(current);
    } catch (error) {
      throw new Error(`Refusing Codex startup: repository skill path cannot be inspected (${error instanceof Error ? error.message : String(error)}).`);
    }
    if (stat.isSymbolicLink()) {
      throw new Error("Refusing Codex startup: symlinked repository skill paths cannot be safely disabled.");
    }
  }
  if (isOutside(relative(repositoryRoot, realpathOrInput(path)))) {
    throw new Error("Refusing Codex startup: repository skill paths escape the repository root.");
  }
}

function isOutside(path: string) {
  return path === ".." || path.startsWith(`..${sep}`) || isAbsolute(path);
}

function scanSkillRoot(path: string, found: Set<string>, depth: number, visited: Set<string>) {
  if (depth > MAX_SKILL_SCAN_DEPTH) throw new Error(`Refusing Codex startup: repository skill nesting exceeds ${MAX_SKILL_SCAN_DEPTH} levels.`);
  if (found.size > MAX_DISCOVERED_SKILLS || !existsSync(path)) return;
  if (lstatSync(path).isSymbolicLink()) {
    throw new Error("Refusing Codex startup: symlinked repository skill paths cannot be safely disabled.");
  }
  const canonical = realpathOrInput(path);
  if (visited.has(canonical)) return;
  visited.add(canonical);
  let entries;
  try {
    entries = readdirSync(path, { withFileTypes: true });
  } catch (error) {
    throw new Error(`Refusing Codex startup: repository skill path cannot be inspected (${error instanceof Error ? error.message : String(error)}).`);
  }
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (found.size > MAX_DISCOVERED_SKILLS) return;
    const child = join(path, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error("Refusing Codex startup: symlinked repository skill paths cannot be safely disabled.");
    }
    if (entry.name === "SKILL.md" && existsSync(child)) found.add(child);
    if (entry.isDirectory()) scanSkillRoot(child, found, depth + 1, visited);
  }
}

function repositoryRoot(cwd: string) {
  let current = realpathOrInput(cwd);
  while (true) {
    if (existsSync(join(current, ".git"))) return current;
    const parent = dirname(current);
    if (parent === current) return realpathOrInput(cwd);
    current = parent;
  }
}

function realpathOrInput(path: string) {
  try {
    return realpathSync.native(path);
  } catch {
    return path;
  }
}

function tomlProjectKey(path: string) {
  return `projects.${JSON.stringify(path)}`;
}
