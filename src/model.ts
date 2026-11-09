import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";

export const PLUGIN_VERSION = "0.1.0";
export const FORMAT_VERSION = 1;
export const backupID = z.string().regex(/^b_[a-f0-9]{32}$/);
export const revisionID = z.string().regex(/^r_[a-f0-9]{32}$/);
export const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const label = z.string().trim().min(1).max(200);
export const transferSchema = z.object({
  info: z.object({
    id: z.string().startsWith("ses"), title: z.string().optional(), projectID: z.string(),
    cost: z.number(), tokens: z.object({ input: z.number(), output: z.number(), reasoning: z.number(),
      cache: z.object({ read: z.number(), write: z.number() }) }),
    time: z.object({ created: z.number(), updated: z.number() }).catchall(z.json()),
    location: z.object({ directory: z.string() }).catchall(z.json()),
  }).catchall(z.json()),
  messages: z.array(z.object({ id: z.string().startsWith("msg_"), type: z.string() }).catchall(z.json())),
}).strict();
export type Transfer = z.infer<typeof transferSchema>;
export const revisionSchema = z.object({
  id: revisionID,
  parent: revisionID.optional(),
  sourceBase: revisionID.optional(),
  sha256: digest,
  contentHash: digest,
  bytes: z.number().int().positive(),
  createdAt: z.iso.datetime(),
  device: label,
  sourceSessionID: z.string(),
  opencodeVersion: label,
  pluginVersion: label,
  formatVersion: z.literal(FORMAT_VERSION),
  sanitize: z.boolean(),
}).strict();
export const entrySchema = z.object({
  id: backupID,
  title: label,
  project: label.optional(),
  revisions: z.array(revisionSchema).min(1),
}).strict();
export const indexSchema = z.object({
  formatVersion: z.literal(FORMAT_VERSION),
  generation: z.string(),
  sessions: z.array(entrySchema),
}).strict().superRefine((index, ctx) => {
  if (new Set(index.sessions.map((s) => s.id)).size !== index.sessions.length)
    ctx.addIssue({ code: "custom", message: "Duplicate backup IDs" });
  for (const entry of index.sessions) {
    if (new Set(entry.revisions.map((r) => r.id)).size !== entry.revisions.length)
      ctx.addIssue({ code: "custom", message: "Duplicate revision IDs" });
  }
});
export type Index = z.infer<typeof indexSchema>;
export type Entry = z.infer<typeof entrySchema>;
export type Revision = z.infer<typeof revisionSchema>;
export const bindingSchema = z.object({
  backupID,
  baseRevision: revisionID,
  chooseOnUpload: z.boolean(),
}).strict();
export type Binding = z.infer<typeof bindingSchema>;

export function id(prefix: "b" | "r"): string {
  return `${prefix}_${randomUUID().replaceAll("-", "")}`;
}
export function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value).filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
// Identity, viewing/import timestamps and machine-local location are not transcript changes.
export function contentHash(data: Transfer): string {
  const { id: _id, time: _time, location: _location, projectID: _project, subpath: _subpath,
    parentID: _parent, fork: _fork, revert: _revert, permissions: _permissions, ...info } = data.info;
  return sha256(canonical({ info, messages: data.messages.map(({ id: _id, ...message }) => message) }));
}
export function filePath(backup: string, revision: string): string {
  return `sessions/${backupID.parse(backup)}/${revisionID.parse(revision)}.json`;
}
export function versionWarnings(revision: Revision, opencodeVersion: string): string[] {
  const warnings: string[] = [];
  if (revision.opencodeVersion !== opencodeVersion)
    warnings.push(`OpenCode：备份 ${revision.opencodeVersion}，当前 ${opencodeVersion}`);
  if (revision.pluginVersion !== PLUGIN_VERSION)
    warnings.push(`插件：备份 ${revision.pluginVersion}，当前 ${PLUGIN_VERSION}`);
  return warnings;
}
export class SyncError extends Error {
  constructor(public readonly code: string, message: string) { super(message); }
}

/** Only identity/relationship fields change. User text, tool inputs and native replay data remain untouched. */
export function freshImport(data: Transfer, directory: string): Transfer {
  const copy = structuredClone(data);
  copy.info.id = `ses_${randomUUID().replaceAll("-", "")}`;
  copy.info.location = { directory };
  delete copy.info.parentID;
  delete copy.info.fork;
  delete copy.info.subpath;
  // A single-session import cannot restore foreign filesystem revert state or trust saved permissions.
  delete copy.info.revert;
  delete copy.info.permissions;
  delete copy.info.time.archived;
  const ids = new Set<string>();
  for (const message of copy.messages) {
    if (ids.has(message.id)) throw new SyncError("invalid_backup", "备份包含重复消息 ID。");
    ids.add(message.id);
    message.id = `msg_${randomUUID().replaceAll("-", "")}`;
  }
  return copy;
}
