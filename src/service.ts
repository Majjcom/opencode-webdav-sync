import { randomUUID } from "node:crypto";
import { defaultProject, remoteKey } from "./config.js";
import type { Config } from "./config.js";
import { bindingSchema, canonical, contentHash, filePath, FORMAT_VERSION, id, indexSchema,
  PLUGIN_VERSION, sha256, SyncError, transferSchema, versionWarnings } from "./model.js";
import type { Binding, Entry, Index, Revision, Transfer } from "./model.js";
import { WebDAV } from "./webdav.js";

export interface Storage {
  get(key: string): Promise<unknown>;
  set(key: string, value: Binding): Promise<void>;
}
export interface Snapshot { index: Index; token: string; exists: boolean; etag?: string }
export interface UploadInput {
  data: Transfer;
  target?: string;
  project?: string;
  expectedToken: string;
  allowConflict?: boolean;
  allowVersionMismatch?: boolean;
}
const busy = new Set<string>();

export class BackupService {
  readonly key: string;
  constructor(readonly dav: WebDAV, private readonly storage: Storage,
    readonly opencodeVersion: string, readonly directory: string) {
    this.key = remoteKey(dav.config);
  }
  get config(): Config { return this.dav.config; }
  private async exclusive<T>(fn: () => Promise<T>): Promise<T> {
    if (busy.has(this.key)) throw new SyncError("busy", "此服务器已有操作正在执行，请稍后重试。");
    busy.add(this.key);
    try { return await fn(); } finally { busy.delete(this.key); }
  }
  private bindingKey(sessionID: string): string { return `binding/${this.key}/${sha256(sessionID)}`; }
  async binding(sessionID: string): Promise<Binding | undefined> {
    const raw = await this.storage.get(this.bindingKey(sessionID));
    if (raw === undefined) return undefined;
    const parsed = bindingSchema.safeParse(raw);
    if (!parsed.success) throw new SyncError("local_state", "本地备份关联记录损坏；请先检查插件存储。");
    return parsed.data;
  }
  async remember(sessionID: string, backupID: string, baseRevision: string, chooseOnUpload: boolean): Promise<void> {
    await this.storage.set(this.bindingKey(sessionID), bindingSchema.parse({ backupID, baseRevision, chooseOnUpload }));
  }
  async rememberDownloaded(input: { sessionID: string; backupID: string; revisionID: string; expectedToken: string }, signal?: AbortSignal): Promise<void> {
    const snapshot = await this.expected(input.expectedToken, signal);
    this.revision(this.entry(snapshot.index, input.backupID), input.revisionID);
    await this.remember(input.sessionID, input.backupID, input.revisionID, true);
  }
  async snapshot(signal?: AbortSignal): Promise<Snapshot> {
    const raw = await this.dav.get("index.json", signal, 16 * 1024 * 1024);
    // Confirmation is bound to both the index and non-secret operation settings.
    const token = sha256(canonical({ remote: this.key, username: this.config.username, device: this.config.device,
      sanitize: this.config.sanitize, maxBackupBytes: this.config.maxBackupBytes,
      opencodeVersion: this.opencodeVersion, pluginVersion: PLUGIN_VERSION,
      index: raw ? sha256(raw.bytes) : null }));
    if (!raw) return { index: { formatVersion: FORMAT_VERSION, generation: "empty", sessions: [] }, token, exists: false };
    let parsed: unknown;
    try { parsed = JSON.parse(raw.bytes.toString("utf8")); }
    catch { throw new SyncError("invalid_index", "index.json 不是有效 JSON；已停止操作，不会重建或覆盖。"); }
    const index = indexSchema.safeParse(parsed);
    if (!index.success) throw new SyncError("incompatible_index", "index.json 格式不兼容或已损坏；请手动检查格式版本与索引，不会覆盖。");
    return { index: index.data, token, etag: raw.etag, exists: true };
  }
  private async expected(token: string, signal?: AbortSignal): Promise<Snapshot> {
    const snapshot = await this.snapshot(signal);
    if (snapshot.token !== token) throw new SyncError("index_changed", "远端索引已变化，请刷新列表后重新确认。");
    return snapshot;
  }
  private async save(snapshot: Snapshot, signal?: AbortSignal): Promise<void> {
    await this.expected(snapshot.token, signal);
    snapshot.index.generation = randomUUID();
    const headers: Record<string, string> = {};
    if (!snapshot.exists) headers["If-None-Match"] = "*";
    else if (snapshot.etag && !snapshot.etag.startsWith("W/")) headers["If-Match"] = snapshot.etag;
    const body = JSON.stringify(indexSchema.parse(snapshot.index), null, 2);
    if (Buffer.byteLength(body) > 16 * 1024 * 1024) throw new SyncError("too_large", "索引超过 16 MiB，拒绝写入无法再次读取的索引。");
    await this.dav.put("index.json", body, signal, headers);
  }
  async overview(sessionID?: string, signal?: AbortSignal) {
    const snapshot = await this.snapshot(signal);
    return { ...snapshot, binding: sessionID ? await this.binding(sessionID) : undefined,
      settings: { projects: this.config.projects, defaultProject: defaultProject(this.config, this.directory),
        device: this.config.device, sanitize: this.config.sanitize, opencodeVersion: this.opencodeVersion,
        pluginVersion: PLUGIN_VERSION } };
  }
  private entry(index: Index, backupID: string): Entry {
    const entry = index.sessions.find((s) => s.id === backupID);
    if (!entry) throw new SyncError("not_found", "备份条目已不存在，请刷新列表。");
    return entry;
  }
  private revision(entry: Entry, revisionID: string): Revision {
    const revision = entry.revisions.find((r) => r.id === revisionID);
    if (!revision) throw new SyncError("not_found", "历史版本已不存在，请刷新列表。");
    return revision;
  }
  async upload(input: UploadInput, signal?: AbortSignal) {
    return this.exclusive(async () => {
      const snapshot = await this.expected(input.expectedToken, signal);
      if (!snapshot.exists && (await this.dav.list("sessions", signal)).length)
        throw new SyncError("index_missing", "索引缺失但存在历史目录；请先手动恢复 index.json，避免遗失历史。");
      const data = transferSchema.parse(input.data);
      const hash = contentHash(data);
      const binding = await this.binding(data.info.id);
      const entry = input.target ? this.entry(snapshot.index, input.target) : undefined;
      const latest = entry?.revisions.at(-1);
      if (latest) {
        const warnings = versionWarnings(latest, this.opencodeVersion);
        if (warnings.length && !input.allowVersionMismatch)
          throw new SyncError("version_mismatch", warnings.join("\n"));
        if (latest.contentHash === hash && latest.sanitize === this.config.sanitize) {
          if (entry!.project !== input.project) {
            entry!.project = input.project;
            await this.save(snapshot, signal);
          }
          await this.remember(data.info.id, entry!.id, latest.id, false);
          return { status: "unchanged" as const, backupID: entry!.id, revisionID: latest.id };
        }
        if ((!binding || binding.backupID !== entry!.id || binding.baseRevision !== latest.id) && !input.allowConflict)
          throw new SyncError("conflict", "远端已推进或无法确定共同基础版本，需要手动决定如何处理。");
      }
      const body = JSON.stringify(data);
      const bytes = Buffer.byteLength(body);
      if (bytes > this.config.maxBackupBytes) throw new SyncError("too_large", "导出数据超过 maxBackupBytes 限制。");
      const backup = entry?.id ?? id("b");
      const revision: Revision = {
        id: id("r"), parent: latest?.id,
        sourceBase: binding?.backupID === backup ? binding.baseRevision : undefined,
        sha256: sha256(body), contentHash: hash, bytes,
        createdAt: new Date().toISOString(), device: this.config.device,
        sourceSessionID: data.info.id, opencodeVersion: this.opencodeVersion,
        pluginVersion: PLUGIN_VERSION, formatVersion: FORMAT_VERSION, sanitize: this.config.sanitize,
      };
      await this.dav.ensureBackup(backup, signal);
      // Never overwrite a history object. A failed index commit leaves a recoverable orphan.
      await this.dav.put(filePath(backup, revision.id), body, signal, { "If-None-Match": "*" });
      if (entry) { entry.project = input.project; entry.revisions.push(revision); }
      else snapshot.index.sessions.push({ id: backup, title: (data.info.title?.trim() || "未命名 session").slice(0, 200),
        project: input.project, revisions: [revision] });
      await this.save(snapshot, signal);
      await this.remember(data.info.id, backup, revision.id, false);
      return { status: "uploaded" as const, backupID: backup, revisionID: revision.id };
    });
  }
  async download(input: { backupID: string; revisionID: string; expectedToken: string; allowVersionMismatch?: boolean }, signal?: AbortSignal) {
    const snapshot = await this.expected(input.expectedToken, signal);
    const revision = this.revision(this.entry(snapshot.index, input.backupID), input.revisionID);
    const warnings = versionWarnings(revision, this.opencodeVersion);
    if (warnings.length && !input.allowVersionMismatch) throw new SyncError("version_mismatch", warnings.join("\n"));
    const raw = await this.dav.get(filePath(input.backupID, revision.id), signal);
    if (!raw) throw new SyncError("missing_file", "索引引用的历史文件不存在，请检查服务器。");
    if (raw.bytes.length !== revision.bytes || sha256(raw.bytes) !== revision.sha256)
      throw new SyncError("checksum", "备份大小或 SHA-256 校验失败，已禁止导入。");
    let data: Transfer;
    try { data = transferSchema.parse(JSON.parse(raw.bytes.toString("utf8"))); }
    catch { throw new SyncError("invalid_backup", "备份内容不符合官方会话导出基本结构，已禁止导入。"); }
    return { data, revision };
  }
  async edit(input: { backupID: string; title: string; project?: string; expectedToken: string }, signal?: AbortSignal) {
    return this.exclusive(async () => {
      const snapshot = await this.expected(input.expectedToken, signal);
      const entry = this.entry(snapshot.index, input.backupID);
      entry.title = input.title;
      entry.project = input.project;
      await this.save(snapshot, signal);
      return { ok: true as const };
    });
  }
  async remove(input: { backupID: string; revisionID?: string; expectedToken: string }, signal?: AbortSignal) {
    return this.exclusive(async () => {
      const snapshot = await this.expected(input.expectedToken, signal);
      const entry = this.entry(snapshot.index, input.backupID);
      const removed = input.revisionID ? [this.revision(entry, input.revisionID)] : [...entry.revisions];
      entry.revisions = entry.revisions.filter((r) => !removed.includes(r));
      if (!entry.revisions.length) snapshot.index.sessions = snapshot.index.sessions.filter((s) => s !== entry);
      await this.save(snapshot, signal);
      const failed: string[] = [];
      for (const revision of removed) {
        const file = filePath(entry.id, revision.id);
        try { await this.dav.delete(file, signal); } catch { failed.push(file); }
      }
      return { ok: true as const, failed };
    });
  }
  private async orphans(snapshot: Snapshot, signal?: AbortSignal): Promise<string[]> {
    if (!snapshot.exists) throw new SyncError("index_missing", "索引缺失，不能判断孤立文件；请先恢复索引或完成首次上传。");
    const referenced = new Set(snapshot.index.sessions.flatMap((s) => s.revisions.map((r) => filePath(s.id, r.id))));
    const files: string[] = [];
    for (const folder of await this.dav.list("sessions", signal)) {
      if (!folder.collection || !/^sessions\/b_[a-f0-9]{32}$/.test(folder.path)) continue;
      for (const file of await this.dav.list(folder.path, signal)) {
        if (!file.collection && /^sessions\/b_[a-f0-9]{32}\/r_[a-f0-9]{32}\.json$/.test(file.path) && !referenced.has(file.path)) files.push(file.path);
      }
    }
    return [...new Set(files)].sort();
  }
  async scan(signal?: AbortSignal) {
    const snapshot = await this.snapshot(signal);
    const paths = await this.orphans(snapshot, signal);
    await this.expected(snapshot.token, signal);
    return { paths, token: snapshot.token, scanToken: sha256(canonical(paths)) };
  }
  async clean(input: { expectedToken: string; scanToken: string }, signal?: AbortSignal) {
    return this.exclusive(async () => {
      const snapshot = await this.expected(input.expectedToken, signal);
      const paths = await this.orphans(snapshot, signal);
      if (sha256(canonical(paths)) !== input.scanToken) throw new SyncError("scan_changed", "孤立文件列表已变化，请重新扫描并确认。");
      await this.expected(snapshot.token, signal);
      const failed: string[] = [];
      for (const file of paths) {
        try { await this.dav.delete(file, signal); } catch { failed.push(file); }
      }
      return { deleted: paths.length - failed.length, failed };
    });
  }
  async test(signal?: AbortSignal) {
    // Read-only connectivity check. No test credentials or dummy session is written.
    await this.dav.list("", signal);
    const snapshot = await this.snapshot(signal);
    return { ok: true as const, indexExists: snapshot.exists, sessions: snapshot.index.sessions.length };
  }
}
