import { configSchema } from "../src/config.js";
import { BackupService } from "../src/service.js";
import { WebDAV } from "../src/webdav.js";
import { sha256 } from "../src/model.js";
import type { Transfer } from "../src/model.js";

export const config = () => configSchema.parse({ url: "https://dav.test/dav/", username: "alice", password: "very-secret", root: "backups", device: "test" });
export function transcript(text = "hello", sessionID = "ses_original"): Transfer {
  return {
    info: { id: sessionID, title: "Test session", projectID: "global", cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      time: { created: 1, updated: 2 }, location: { directory: "D:/source" } },
    messages: [{ id: "msg_original", type: "user", text, time: { created: 1 } }],
  };
}
const xmlEscape = (s: string) => s.replaceAll("&", "&amp;").replaceAll("<", "&lt;");
export class FakeDAV {
  files = new Map<string, string>();
  directories = new Set([""]);
  trace: Array<{ method: string; path: string; headers: Headers }> = [];
  failure?: { method: string; path: string; status: number };
  xml?: string;
  hook?: (method: string, path: string) => void;
  fetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const relative = decodeURIComponent(url.pathname).replace(/^\/dav\/backups\/?/, "").replace(/\/$/, "");
    const method = init?.method ?? "GET";
    const headers = new Headers(init?.headers);
    this.trace.push({ method, path: relative, headers });
    this.hook?.(method, relative);
    if (this.failure?.method === method && this.failure.path === relative) {
      const status = this.failure.status; this.failure = undefined;
      return new Response(null, { status });
    }
    if (method === "GET") {
      const body = this.files.get(relative);
      return body === undefined ? new Response(null, { status: 404 }) : new Response(body, { headers: { ETag: `"${sha256(body)}"` } });
    }
    if (method === "PUT") {
      const old = this.files.get(relative);
      if ((headers.get("if-none-match") === "*" && old !== undefined)
        || (headers.has("if-match") && (old === undefined || headers.get("if-match") !== `"${sha256(old)}"`)))
        return new Response(null, { status: 412 });
      this.files.set(relative, String(init?.body));
      return new Response(null, { status: 201 });
    }
    if (method === "MKCOL") { this.directories.add(relative); return new Response(null, { status: 201 }); }
    if (method === "DELETE") { this.files.delete(relative); return new Response(null, { status: 204 }); }
    if (method === "PROPFIND") {
      if (this.xml !== undefined) return new Response(this.xml, { status: 207 });
      if (!this.directories.has(relative)) return new Response(null, { status: 404 });
      const prefix = relative ? `${relative}/` : "";
      const paths = [...this.directories, ...this.files.keys()].filter((p) => p === relative
        || (p.startsWith(prefix) && !p.slice(prefix.length).includes("/")));
      const rows = [...new Set(paths)].map((p) => `<d:response><d:href>${xmlEscape(`/dav/backups/${p}${this.directories.has(p) && p ? "/" : ""}`)}</d:href>`
        + `<d:propstat><d:prop><d:resourcetype>${this.directories.has(p) ? "<d:collection/>" : ""}</d:resourcetype></d:prop>`
        + "<d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>");
      return new Response(`<d:multistatus xmlns:d="DAV:">${rows.join("")}</d:multistatus>`, { status: 207 });
    }
    return new Response(null, { status: 405 });
  };
}
export function harness(fake = new FakeDAV(), store = new Map<string, unknown>(), version = "2.2.6") {
  const cfg = config();
  const dav = new WebDAV(cfg, fake.fetch);
  const service = new BackupService(dav, { get: async (key) => store.get(key), set: async (key, value) => { store.set(key, value); } }, version, "D:/source");
  return { service, fake, store, cfg, dav };
}
export async function firstUpload(h = harness(), data = transcript()) {
  const snapshot = await h.service.snapshot();
  const uploaded = await h.service.upload({ data, expectedToken: snapshot.token, project: "my-app" });
  return { ...h, uploaded };
}
