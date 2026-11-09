import { XMLParser, XMLValidator } from "fast-xml-parser";
import type { Config } from "./config.js";
import { SyncError } from "./model.js";

export interface Resource { path: string; collection: boolean }
export class WebDAV {
  readonly root: URL;
  constructor(readonly config: Config, private readonly fetcher: typeof fetch = fetch) {
    const base = new URL(config.url.endsWith("/") ? config.url : `${config.url}/`);
    this.root = new URL(`${config.root.split("/").map(encodeURIComponent).join("/")}/`, base);
  }
  url(relative: string): URL {
    if (relative && relative.split("/").some((p) => !p || p === "." || p === ".." || /[\\%?#\u0000-\u001f]/.test(p)))
      throw new SyncError("unsafe_path", "拒绝访问不安全的远端路径。");
    return new URL(relative.split("/").map(encodeURIComponent).join("/"), this.root);
  }
  private async request(method: string, url: URL, signal?: AbortSignal, body?: string, headers?: Record<string, string>): Promise<Response> {
    try {
      return await this.fetcher(url, {
        method, body, redirect: "error",
        headers: { Authorization: `Basic ${Buffer.from(`${this.config.username}:${this.config.password}`).toString("base64")}`,
          ...headers },
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(this.config.timeoutMs)])
          : AbortSignal.timeout(this.config.timeoutMs),
      });
    } catch {
      throw new SyncError("network", "WebDAV 请求失败、已取消或超时。请检查网络、证书和连接参数；不自动重试写入。");
    }
  }
  private async bytes(response: Response, max: number): Promise<Buffer> {
    if (Number(response.headers.get("content-length")) > max) {
      await response.body?.cancel();
      throw new SyncError("too_large", "远端文件超过允许大小。");
    }
    const reader = response.body?.getReader();
    if (!reader) return Buffer.alloc(0);
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.length;
        if (total > max) throw new SyncError("too_large", "远端文件超过允许大小。");
        chunks.push(value);
      }
    } catch (error) {
      await reader.cancel().catch(() => {});
      if (error instanceof SyncError) throw error;
      throw new SyncError("network", "读取 WebDAV 响应失败、已取消或超时。");
    } finally { reader.releaseLock(); }
    return Buffer.concat(chunks);
  }
  private async check(response: Response, allowed: number[]): Promise<void> {
    if (!allowed.includes(response.status)) {
      await response.body?.cancel();
      throw new SyncError(response.status === 412 ? "index_changed" : "webdav_status",
        `WebDAV 返回 HTTP ${response.status}。请检查认证、权限或服务器状态。`);
    }
  }
  async get(relative: string, signal?: AbortSignal, max = this.config.maxBackupBytes): Promise<{ bytes: Buffer; etag?: string } | undefined> {
    const response = await this.request("GET", this.url(relative), signal);
    if (response.status === 404) { await response.body?.cancel(); return undefined; }
    await this.check(response, [200]);
    return { bytes: await this.bytes(response, max), etag: response.headers.get("etag") ?? undefined };
  }
  async put(relative: string, value: string, signal?: AbortSignal, headers?: Record<string, string>): Promise<void> {
    const response = await this.request("PUT", this.url(relative), signal, value,
      { "Content-Type": "application/json; charset=utf-8", ...headers });
    await this.check(response, [200, 201, 204]);
    await response.body?.cancel();
  }
  async delete(relative: string, signal?: AbortSignal): Promise<void> {
    const response = await this.request("DELETE", this.url(relative), signal);
    await this.check(response, [200, 202, 204, 404]);
    await response.body?.cancel();
  }
  private async mkdir(url: URL, signal?: AbortSignal): Promise<void> {
    const response = await this.request("MKCOL", url, signal);
    await this.check(response, [200, 201, 204, 405]);
    await response.body?.cancel();
  }
  async ensureRoot(signal?: AbortSignal): Promise<void> {
    const base = new URL(this.config.url.endsWith("/") ? this.config.url : `${this.config.url}/`);
    let url = base;
    for (const part of this.config.root.split("/")) {
      url = new URL(`${encodeURIComponent(part)}/`, url);
      await this.mkdir(url, signal);
    }
  }
  async ensureBackup(backup: string, signal?: AbortSignal): Promise<void> {
    await this.ensureRoot(signal);
    await this.mkdir(this.url("sessions"), signal);
    await this.mkdir(this.url(`sessions/${backup}`), signal);
  }
  async list(relative: string, signal?: AbortSignal): Promise<Resource[]> {
    const target = this.url(relative);
    const response = await this.request("PROPFIND", target, signal,
      '<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/></d:prop></d:propfind>',
      { Depth: "1", "Content-Type": "application/xml; charset=utf-8" });
    if (response.status === 404) { await response.body?.cancel(); return []; }
    await this.check(response, [207]);
    const xml = (await this.bytes(response, 8 * 1024 * 1024)).toString("utf8");
    if (/<!DOCTYPE|<!ENTITY/i.test(xml) || XMLValidator.validate(xml) !== true)
      throw new SyncError("invalid_listing", "WebDAV 返回无效或不安全的 XML 列表。");
    const parsed = new XMLParser({ removeNSPrefix: true, ignoreAttributes: true,
      parseTagValue: false, processEntities: false }).parse(xml);
    const rows = parsed?.multistatus?.response;
    if (!rows) throw new SyncError("invalid_listing", "WebDAV 响应缺少 multistatus 列表。");
    const rootPath = this.root.pathname;
    const targetPath = target.pathname.replace(/\/$/, "");
    const result: Resource[] = [];
    for (const row of Array.isArray(rows) ? rows : [rows]) {
      if (typeof row.href !== "string") throw new SyncError("invalid_listing", "WebDAV 列表缺少 href。");
      // Decode ordinary XML escapes without enabling document-defined entities.
      const href = row.href.replaceAll("&amp;", "&").replaceAll("&lt;", "<").replaceAll("&gt;", ">")
        .replaceAll("&quot;", '"').replaceAll("&apos;", "'");
      const url = new URL(href, target);
      if (url.origin !== this.root.origin || url.search || url.hash || !url.pathname.startsWith(rootPath)) continue;
      const pathname = url.pathname.replace(/\/$/, "");
      if (pathname === targetPath || !pathname.startsWith(`${targetPath}/`)
        || pathname.slice(targetPath.length + 1).includes("/")) continue;
      let decoded: string;
      try { decoded = decodeURIComponent(pathname.slice(rootPath.length)); } catch { continue; }
      if (decoded.split("/").some((p) => !p || p === "." || p === ".." || /[\\%?#\u0000-\u001f]/.test(p))) continue;
      const props = Array.isArray(row.propstat) ? row.propstat : [row.propstat];
      const good = props.filter((p: { status?: string } | undefined) => /\s200\s/.test(p?.status ?? ""));
      if (!good.length) throw new SyncError("invalid_listing", "无法读取部分 WebDAV 资源属性，已停止扫描。");
      result.push({ path: decoded, collection: good.some((p: { prop?: { resourcetype?: object } }) =>
        p.prop?.resourcetype && typeof p.prop.resourcetype === "object" && "collection" in p.prop.resourcetype) });
    }
    return result;
  }
}
