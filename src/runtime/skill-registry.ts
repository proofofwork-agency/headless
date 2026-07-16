import { createHash, randomUUID } from "node:crypto";
import { cpSync, existsSync, lstatSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { z } from "zod";
import { PortableSkillManifestSchema, PortableSkillRecordSchema, SkillAuditEntrySchema } from "../contracts/skill";
import type { Job } from "../contracts/durable";
import { HeadlessError } from "./headless-error";
import { readOwnerOnlyJson, writeOwnerOnlyJson } from "./owner-json";
import type { ProjectStatePaths } from "./project-state";
import { redactAndTruncate } from "./redaction";

const MAX_FILES = 64;
const MAX_FILE_BYTES = 256_000;
const MAX_TOTAL_BYTES = 1_000_000;
const RegistrySchema = z.object({ version: z.literal(1), projectId: z.string().length(64), skills: z.array(PortableSkillRecordSchema).max(512), audit: z.array(SkillAuditEntrySchema).max(2_000) }).strict();

export class SkillRegistry {
  private readonly registryPath;
  private state: z.infer<typeof RegistrySchema>;

  constructor(private readonly paths: ProjectStatePaths) {
    this.registryPath = join(paths.skillsDir, "registry.json");
    const persisted = existsSync(this.registryPath) ? readOwnerOnlyJson(this.registryPath, RegistrySchema) : null;
    this.state = persisted ?? RegistrySchema.parse({ version: 1, projectId: paths.projectId, skills: [], audit: [] });
    if (this.state.projectId !== paths.projectId) throw new Error("Skill registry belongs to another project.");
    this.write();
  }

  list() { return structuredClone(this.state.skills); }
  audit() { return structuredClone(this.state.audit); }

  import(source: string, actor: string) {
    const inspected = inspectBundle(source);
    const existing = this.state.skills.find((skill) => skill.id === inspected.manifest.id && skill.version === inspected.manifest.version);
    if (existing) {
      if (existing.contentHash !== inspected.hash) throw new HeadlessError("POLICY_DENIED", "The same skill id and version already exists with different immutable content.");
      return existing;
    }
    const record = PortableSkillRecordSchema.parse({
      schemaVersion: 1, id: inspected.manifest.id, version: inspected.manifest.version, projectId: this.paths.projectId,
      source: inspected.root, contentHash: inspected.hash, license: inspected.manifest.license, manifest: inspected.manifest,
      state: "quarantined", importedAt: Date.now(), importedBy: actor, approvedAt: null, approvedBy: null, revokedAt: null,
    });
    const bundleDir = join(this.paths.skillsDir, `${record.id}@${record.version}-${record.contentHash.slice(0, 16)}`);
    if (existsSync(bundleDir)) throw new HeadlessError("POLICY_DENIED", "Immutable skill bundle destination already exists.");
    cpSync(inspected.root, bundleDir, { recursive: true, errorOnExist: true, force: false });
    this.state.skills.push(record);
    this.write();
    return record;
  }

  inspect(idVersion: string) {
    const skill = this.require(idVersion);
    return { ...structuredClone(skill), content: this.content(skill) };
  }

  enable(idVersion: string, actor: string) {
    const skill = this.require(idVersion);
    if (skill.state === "revoked") throw new HeadlessError("POLICY_DENIED", "A revoked immutable skill version cannot be re-enabled.");
    const current = inspectBundle(this.bundleRoot(skill));
    if (current.hash !== skill.contentHash) throw new HeadlessError("POLICY_DENIED", "Skill source changed after quarantine; import a new version.");
    Object.assign(skill, { state: "enabled", approvedAt: Date.now(), approvedBy: actor });
    this.write();
    return skill;
  }

  revoke(idVersion: string) {
    const skill = this.require(idVersion);
    Object.assign(skill, { state: "revoked", revokedAt: Date.now() });
    this.write();
    return skill;
  }

  invocation(idVersion: string, args: string, actor: string, receivers: string[]) {
    const skill = this.require(idVersion);
    if (skill.state !== "enabled") throw new HeadlessError("POLICY_DENIED", `Skill ${idVersion} is ${skill.state}; explicit enablement is required.`);
    const content = this.content(skill);
    const safeArgs = redactAndTruncate(args, 64_000).text;
    const prompt = `HEADLESS PORTABLE SKILL ${skill.id}@${skill.version}\nImmutable content hash: ${skill.contentHash}\nNative provider skills, hooks, plugins, MCP configuration, and package installation remain disabled.\n\n${content}\n\nBOUNDED ARGUMENTS:\n${safeArgs || "(none)"}`;
    const audit = SkillAuditEntrySchema.parse({ id: randomUUID(), projectId: this.paths.projectId, skillId: skill.id, version: skill.version, contentHash: skill.contentHash, arguments: safeArgs, authority: actor, receivers, result: "admitted", createdAt: Date.now() });
    this.state.audit.push(audit);
    this.state.audit = this.state.audit.slice(-2_000);
    this.write();
    return { skill, prompt, auditId: audit.id };
  }

  completeInvocation(auditId: string, result: unknown) {
    const audit = this.state.audit.find((entry) => entry.id === auditId);
    if (!audit) throw new HeadlessError("INVALID_REQUEST", `Unknown skill audit entry: ${auditId}`);
    audit.result = redactAndTruncate(typeof result === "string" ? result : JSON.stringify(result ?? null), 16_384).text;
    this.write();
    return audit;
  }

  markInvocationPending(auditId: string, jobId: string) {
    const audit = this.requireAudit(auditId);
    audit.jobId = jobId;
    audit.status = "running";
    audit.result = "running";
    this.write();
    return audit;
  }

  completeJobInvocation(auditId: string, job: Job) {
    const audit = this.requireAudit(auditId);
    if (audit.jobId !== job.id || audit.status !== "running") return audit;
    if (job.state === "queued" || job.state === "preparing" || job.state === "running" || job.state === "cancelling") {
      throw new HeadlessError("CONFLICT", `Skill invocation job ${job.id} is not terminal.`);
    }
    audit.status = job.state;
    audit.result = redactAndTruncate(JSON.stringify({ jobId: job.id, status: job.state, result: job.result }), 16_384).text;
    this.write();
    return audit;
  }

  failPendingInvocation(auditId: string, error: string) {
    const audit = this.requireAudit(auditId);
    if (audit.status !== "running") return audit;
    audit.status = "failed";
    audit.result = redactAndTruncate(JSON.stringify({ jobId: audit.jobId, status: "failed", error }), 16_384).text;
    this.write();
    return audit;
  }

  pendingInvocations() {
    // Pre-upgrade audit entries intentionally default to admitted/null: older
    // state did not persist a trustworthy job relationship to reconcile.
    return this.state.audit
      .filter((entry) => entry.status === "running" && entry.jobId !== null)
      .map((entry) => ({ auditId: entry.id, jobId: entry.jobId!, principal: entry.authority }));
  }

  private content(skill: z.infer<typeof PortableSkillRecordSchema>) {
    const root = this.bundleRoot(skill);
    const files = [skill.manifest.instructions, ...skill.manifest.references];
    return files.map((path) => `## ${path}\n\n${readFileSync(join(root, path), "utf8")}`).join("\n\n");
  }

  private require(idVersion: string) {
    const [id, version] = idVersion.split("@");
    const skill = this.state.skills.find((item) => item.id === id && (!version || item.version === version));
    if (!skill) throw new HeadlessError("INVALID_REQUEST", `Unknown skill: ${idVersion}`);
    return skill;
  }

  private requireAudit(auditId: string) {
    const audit = this.state.audit.find((entry) => entry.id === auditId);
    if (!audit) throw new HeadlessError("INVALID_REQUEST", `Unknown skill audit entry: ${auditId}`);
    return audit;
  }

  private bundleRoot(skill: z.infer<typeof PortableSkillRecordSchema>) {
    return join(this.paths.skillsDir, `${skill.id}@${skill.version}-${skill.contentHash.slice(0, 16)}`);
  }

  private write() { writeOwnerOnlyJson(this.registryPath, RegistrySchema.parse(this.state)); }
}

function inspectBundle(source: string) {
  if (!isAbsolute(source)) throw new HeadlessError("INVALID_REQUEST", "Skill import source must be an absolute local directory.");
  const root = realpathSync(resolve(source));
  if (!statSync(root).isDirectory()) throw new HeadlessError("INVALID_REQUEST", "Skill import source must be a directory; archives and mutable URLs are not accepted in v1.");
  const files = walk(root);
  if (files.length > MAX_FILES) throw new HeadlessError("POLICY_DENIED", `Skill bundle exceeds ${MAX_FILES} files.`);
  let total = 0;
  const hash = createHash("sha256");
  for (const path of files) {
    const rel = relative(root, path).split(sep).join("/");
    const info = lstatSync(path);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) throw new HeadlessError("POLICY_DENIED", `Skill bundle contains a link or non-regular file: ${rel}`);
    if ((info.mode & 0o111) !== 0) throw new HeadlessError("POLICY_DENIED", `Skill bundle contains executable content: ${rel}`);
    if (info.size > MAX_FILE_BYTES) throw new HeadlessError("POLICY_DENIED", `Skill file exceeds ${MAX_FILE_BYTES} bytes: ${rel}`);
    total += info.size;
    if (total > MAX_TOTAL_BYTES) throw new HeadlessError("POLICY_DENIED", `Skill bundle exceeds ${MAX_TOTAL_BYTES} bytes.`);
    if (!allowedPath(rel)) throw new HeadlessError("POLICY_DENIED", `Skill v1 accepts only manifest.json, instructions.md, and bounded text references: ${rel}`);
    const content = readFileSync(path);
    if (content.includes(0)) throw new HeadlessError("POLICY_DENIED", `Skill bundle contains binary content: ${rel}`);
    hash.update(`${rel}\0${content.length}\0`).update(content);
  }
  if (!files.some((path) => relative(root, path) === "manifest.json") || !files.some((path) => relative(root, path) === "instructions.md")) throw new HeadlessError("INVALID_REQUEST", "Skill bundle requires manifest.json and instructions.md.");
  const manifest = PortableSkillManifestSchema.parse(JSON.parse(readFileSync(join(root, "manifest.json"), "utf8")));
  const declared = new Set(["manifest.json", manifest.instructions, ...manifest.references]);
  for (const path of files) if (!declared.has(relative(root, path).split(sep).join("/"))) throw new HeadlessError("POLICY_DENIED", `Undeclared skill file: ${relative(root, path)}`);
  return { root, files, manifest, hash: hash.digest("hex") };
}

function walk(root: string) {
  const files: string[] = [];
  const visit = (dir: string) => {
    for (const entry of readdirSync(dir).sort()) {
      const path = join(dir, entry);
      const info = lstatSync(path);
      if (info.isSymbolicLink()) throw new HeadlessError("POLICY_DENIED", `Skill bundle contains a symbolic link: ${relative(root, path)}`);
      if (info.isDirectory()) visit(path); else files.push(path);
      if (files.length > MAX_FILES) return;
    }
  };
  visit(root);
  return files;
}

function allowedPath(path: string) {
  return path === "manifest.json" || path === "instructions.md" || /^references\/[a-zA-Z0-9._-]+\.(?:md|txt)$/.test(path);
}
