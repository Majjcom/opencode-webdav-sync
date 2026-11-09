import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { mkdir, open, readFile, realpath, rename, stat, unlink } from "node:fs/promises";
import { homedir, hostname } from "node:os";
import path from "node:path";
import { z } from "zod";
import { label, sha256, SyncError } from "./model.js";

export const workspaceSchema = z.object({
  directory: z.string().trim().min(1).refine((s) => path.posix.isAbsolute(s) || path.win32.isAbsolute(s), "Use an absolute workspace path"),
  project: label,
}).strict();
export const classificationSchema = z.object({
  projects: z.array(label).default([]),
  workspaces: z.array(workspaceSchema).default([]),
}).superRefine((value, ctx) => {
  if (new Set(value.projects).size !== value.projects.length)
    ctx.addIssue({ code: "custom", message: "Duplicate project labels" });
  if (new Set(value.workspaces.map((w) => normalizeDirectory(w.directory))).size !== value.workspaces.length)
    ctx.addIssue({ code: "custom", message: "Duplicate workspace mappings" });
});
export type Classification = z.infer<typeof classificationSchema>;
export const configSchema = z.object({
  url: z.url().refine((s) => {
    const u = new URL(s);
    return u.protocol === "https:" && !u.username && !u.password && !u.search && !u.hash;
  }, "Use an HTTPS collection URL without embedded credentials, query or fragment"),
  username: z.string().min(1).refine((s) => !s.includes(":")),
  password: z.string().min(1),
  root: z.string().default("opencode-backups").refine((s) => s.split("/").every(
    (p) => /^[\p{L}\p{N} _.-]+$/u.test(p) && p !== "." && p !== "..")),
  device: label.default(hostname()),
  timeoutMs: z.number().int().min(1000).max(300000).default(30000),
  maxBackupBytes: z.number().int().min(1024).max(1024 * 1024 * 1024).default(64 * 1024 * 1024),
  sanitize: z.boolean().default(false),
  projects: classificationSchema.shape.projects,
  workspaces: classificationSchema.shape.workspaces,
}).strict();
export type Config = z.infer<typeof configSchema>;
export function configPath(override?: string): string {
  const selected = override ?? process.env.OPENCODE_WEBDAV_CONFIG;
  if (selected) return path.resolve(selected.startsWith("~/") || selected.startsWith("~\\")
    ? path.join(homedir(), selected.slice(2)) : selected);
  const directory = process.env.OPENCODE_CONFIG_DIR
    || path.join(process.env.XDG_CONFIG_HOME || path.join(homedir(), ".config"), "opencode");
  return path.resolve(directory, "webdav-sync.json");
}
export async function loadConfig(file: string): Promise<{ config: Config; warning?: string }> {
  let raw: string;
  try { raw = await readFile(file, "utf8"); }
  catch { throw new SyncError("config_missing", `无法读取配置：${file}。请参考 webdav-sync.example.json 创建配置。`); }
  let config: Config;
  try { config = configSchema.parse(JSON.parse(raw)); }
  catch { throw new SyncError("invalid_config", "配置格式无效：请检查 HTTPS 地址、认证、项目及选项。为保护密码，不展示原始配置。"); }
  const mode = (await stat(file)).mode;
  const warning = process.platform !== "win32" && (mode & 0o077) !== 0
    ? "配置含明文密码，建议将文件权限设为 600。" : undefined;
  return { config, warning };
}
export function defaultProject(config: Config, directory: string): string | undefined {
  return mappedProject(config.workspaces, directory);
}
export function remoteKey(config: Config): string {
  return sha256(`${new URL(config.url).href.replace(/\/+$/, "")}/${config.root}`);
}

export function normalizeDirectory(directory: string): string {
  return process.platform === "win32" ? path.resolve(directory).toLowerCase() : path.resolve(directory);
}
function mappedProject(workspaces: Classification["workspaces"], directory: string): string | undefined {
  return workspaces.find((w) => normalizeDirectory(w.directory) === normalizeDirectory(directory))?.project;
}

// An opaque, process-local token detects edits without publishing a hash of the password.
const settingsKey = randomBytes(32);
const settingsBusy = new Set<string>();
async function configDocument(file: string) {
  let target: string;
  try { target = await realpath(file); }
  catch (error) {
    if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT"))
      throw new SyncError("config_read", "无法读取配置文件路径，请检查本机权限。");
    target = path.resolve(file);
  }
  let raw: string | undefined;
  try { raw = await readFile(target, "utf8"); }
  catch (error) {
    if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT"))
      throw new SyncError("config_read", "无法读取配置文件，请检查本机权限。");
  }
  let value: Record<string, unknown> = {};
  if (raw !== undefined) {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
      value = parsed as Record<string, unknown>;
    } catch { throw new SyncError("invalid_config", "配置不是有效 JSON 对象；不会覆盖，请先手动修复。"); }
  }
  const token = createHmac("sha256", settingsKey).update(target).update("\0").update(raw ?? "<missing>").digest("hex");
  return { target, raw, value, token };
}
function classification(value: unknown): Classification {
  const parsed = classificationSchema.safeParse(value);
  if (!parsed.success) throw new SyncError("invalid_settings", "项目或工作区配置无效：标签需为 1–200 个字符，目录需为绝对路径，且不可重复。");
  return parsed.data;
}
export async function readSettings(file: string, directory: string) {
  const document = await configDocument(file);
  const settings = classification(document.value);
  return { ...settings, token: document.token, configFile: file, directory,
    defaultProject: mappedProject(settings.workspaces, directory),
    currentWorkspaceIndex: settings.workspaces.findIndex((w) => normalizeDirectory(w.directory) === normalizeDirectory(directory)) };
}
export async function saveSettings(file: string, directory: string,
  input: Classification & { expectedToken: string }) {
  const lock = normalizeDirectory((await configDocument(file)).target);
  if (settingsBusy.has(lock)) throw new SyncError("settings_busy", "配置正在保存，请稍后重试。");
  settingsBusy.add(lock);
  let temporary: string | undefined;
  try {
    const document = await configDocument(file);
    if (document.token !== input.expectedToken)
      throw new SyncError("settings_changed", "配置文件已变化，请重新打开设置后再保存。");
    const settings = classification(input);
    await mkdir(path.dirname(document.target), { recursive: true, mode: 0o700 });
    const candidate = `${document.target}.${randomUUID()}.tmp`;
    const handle = await open(candidate, "wx", 0o600);
    temporary = candidate;
    try {
      await handle.writeFile(`${JSON.stringify({ ...document.value, ...settings }, null, 2)}\n`, "utf8");
      await handle.sync();
    } finally { await handle.close(); }
    if ((await configDocument(file)).token !== document.token)
      throw new SyncError("settings_changed", "保存期间配置已变化，请重新打开设置；不会覆盖其他修改。");
    await rename(temporary, document.target);
    temporary = undefined;
    return await readSettings(file, directory);
  } catch (error) {
    if (error instanceof SyncError) throw error;
    throw new SyncError("config_write", "无法安全保存配置，请检查目录或文件权限。不会展示包含凭据的原始错误。");
  } finally {
    if (temporary) await unlink(temporary).catch(() => {});
    settingsBusy.delete(lock);
  }
}
