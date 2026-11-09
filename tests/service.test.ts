import { test } from "node:test";
import assert from "node:assert/strict";
import { BackupService } from "../src/service.js";
import { filePath, freshImport, id } from "../src/model.js";
import { FakeDAV, firstUpload, harness, transcript } from "./helpers.js";

test("upload stores native JSON before unified index and skips unchanged content", async () => {
  const h = await firstUpload();
  const snap = await h.service.snapshot();
  assert.equal(snap.index.sessions.length, 1);
  assert.equal(snap.index.sessions[0]!.project, "my-app");
  const puts = h.fake.trace.filter((r) => r.method === "PUT");
  assert.match(puts[0]!.path, /^sessions\/b_.*\/r_.*\.json$/);
  assert.equal(puts[1]!.path, "index.json");
  assert.deepEqual(JSON.parse(h.fake.files.get(puts[0]!.path)!), transcript());
  const result = await h.service.upload({ data: transcript(), target: h.uploaded.backupID, expectedToken: snap.token, project: "changed-project" });
  assert.equal(result.status, "unchanged");
  assert.equal((await h.service.snapshot()).index.sessions[0]!.revisions.length, 1);
  assert.equal((await h.service.snapshot()).index.sessions[0]!.project, "changed-project");
});
test("changed content appends immutable history and keeps base/parent", async () => {
  const h = await firstUpload();
  await h.service.upload({ data: transcript("new"), target: h.uploaded.backupID, expectedToken: (await h.service.snapshot()).token });
  const entry = (await h.service.snapshot()).index.sessions[0]!;
  assert.equal(entry.revisions.length, 2);
  assert.equal(entry.revisions[1]!.parent, entry.revisions[0]!.id);
  assert.equal(entry.revisions[1]!.sourceBase, entry.revisions[0]!.id);
  assert.equal(h.fake.files.size, 3);
});
test("download validates checksum and does not modify index or session", async () => {
  const h = await firstUpload();
  const token = (await h.service.snapshot()).token;
  const data = await h.service.download({ ...h.uploaded, expectedToken: token });
  assert.deepEqual(data.data, transcript());
  const file = filePath(h.uploaded.backupID, h.uploaded.revisionID);
  h.fake.files.set(file, JSON.stringify(transcript("tampered")));
  await assert.rejects(h.service.download({ ...h.uploaded, expectedToken: token }), /校验失败/);
  assert.equal((await h.service.snapshot()).token, token);
});
test("downloaded session chooses association on upload then can continue without duplicates", async () => {
  const h = await firstUpload();
  const fresh = freshImport(transcript(), "/target");
  await h.service.remember(fresh.info.id, h.uploaded.backupID, h.uploaded.revisionID, true);
  assert.equal((await h.service.overview(fresh.info.id)).binding?.chooseOnUpload, true);
  const result = await h.service.upload({ data: fresh, target: h.uploaded.backupID, expectedToken: (await h.service.snapshot()).token });
  assert.equal(result.status, "unchanged");
  assert.equal((await h.service.binding(fresh.info.id))?.chooseOnUpload, false);
});
test("diverged remote requires manual conflict choice; explicit append preserves both branches", async () => {
  const h = await firstUpload();
  const local = freshImport(transcript("local branch"), "/target");
  await h.service.remember(local.info.id, h.uploaded.backupID, h.uploaded.revisionID, true);
  await h.service.upload({ data: transcript("remote advanced"), target: h.uploaded.backupID, expectedToken: (await h.service.snapshot()).token });
  const input = { data: local, target: h.uploaded.backupID, expectedToken: (await h.service.snapshot()).token };
  await assert.rejects(h.service.upload(input), /手动决定/);
  await h.service.upload({ ...input, allowConflict: true });
  const entry = (await h.service.snapshot()).index.sessions[0]!;
  assert.equal(entry.revisions.length, 3);
  assert.equal(entry.revisions[2]!.sourceBase, h.uploaded.revisionID);
  assert.equal(entry.revisions[2]!.parent, entry.revisions[1]!.id);
});
test("missing shared base is conflict and separate upload remains possible", async () => {
  const h = await firstUpload();
  const input = { data: transcript("other", "ses_other"), target: h.uploaded.backupID, expectedToken: (await h.service.snapshot()).token };
  await assert.rejects(h.service.upload(input), /手动决定/);
  await h.service.upload({ ...input, target: undefined });
  assert.equal((await h.service.snapshot()).index.sessions.length, 2);
});
test("OpenCode and plugin differences require confirmation; incompatible format is blocked", async () => {
  const h = await firstUpload();
  const other = harness(h.fake, h.store, "2.2.7");
  const input = { ...h.uploaded, expectedToken: (await other.service.snapshot()).token };
  await assert.rejects(other.service.download(input), /OpenCode/);
  assert.ok((await other.service.download({ ...input, allowVersionMismatch: true })).data);
  const raw = JSON.parse(h.fake.files.get("index.json")!);
  raw.sessions[0].revisions[0].pluginVersion = "0.2.0";
  h.fake.files.set("index.json", JSON.stringify(raw));
  await assert.rejects(h.service.download({ ...h.uploaded, expectedToken: (await h.service.snapshot()).token }), /插件/);
  raw.formatVersion = 99;
  h.fake.files.set("index.json", JSON.stringify(raw));
  await assert.rejects(h.service.snapshot(), /不兼容/);
});
test("stale confirmation and settings changes invalidate writes", async () => {
  const h = await firstUpload();
  const old = await h.service.snapshot();
  await h.service.edit({ backupID: h.uploaded.backupID, title: "renamed", expectedToken: old.token });
  await assert.rejects(h.service.remove({ backupID: h.uploaded.backupID, expectedToken: old.token }), /已变化/);
  const before = await h.service.snapshot();
  h.cfg.sanitize = true;
  await assert.rejects(h.service.upload({ data: transcript("new"), expectedToken: before.token }), /已变化/);
});
test("rename/project edits leave the immutable official export untouched", async () => {
  const h = await firstUpload();
  const path = filePath(h.uploaded.backupID, h.uploaded.revisionID);
  const raw = h.fake.files.get(path);
  await h.service.edit({ backupID: h.uploaded.backupID, title: "display title", project: "manual", expectedToken: (await h.service.snapshot()).token });
  assert.equal(h.fake.files.get(path), raw);
  assert.equal((await h.service.snapshot()).index.sessions[0]!.title, "display title");
});
test("deletion commits index first, reports failed physical deletion, and allows orphan cleanup", async () => {
  const h = await firstUpload();
  const path = filePath(h.uploaded.backupID, h.uploaded.revisionID);
  h.fake.failure = { method: "DELETE", path, status: 503 };
  const removed = await h.service.remove({ backupID: h.uploaded.backupID, expectedToken: (await h.service.snapshot()).token });
  assert.deepEqual(removed.failed, [path]);
  assert.equal((await h.service.snapshot()).index.sessions.length, 0);
  const trace = h.fake.trace;
  assert.ok(trace.findLastIndex((r) => r.method === "PUT" && r.path === "index.json")
    < trace.findLastIndex((r) => r.method === "DELETE"));
  const scan = await h.service.scan();
  assert.deepEqual(scan.paths, [path]);
  const clean = await h.service.clean({ expectedToken: scan.token, scanToken: scan.scanToken });
  assert.equal(clean.deleted, 1);
  assert.equal(h.fake.files.has(path), false);
});
test("delete one historical revision leaves other versions downloadable", async () => {
  const h = await firstUpload();
  await h.service.upload({ data: transcript("second"), target: h.uploaded.backupID, expectedToken: (await h.service.snapshot()).token });
  await h.service.remove({ ...h.uploaded, expectedToken: (await h.service.snapshot()).token });
  const snapshot = await h.service.snapshot();
  const entry = snapshot.index.sessions[0]!;
  assert.equal(entry.revisions.length, 1);
  assert.equal((await h.service.download({ backupID: entry.id, revisionID: entry.revisions[0]!.id, expectedToken: snapshot.token })).data.messages[0]!.text, "second");
});
test("interrupted index commit leaves previous index and a visible orphan", async () => {
  const h = await firstUpload();
  const before = h.fake.files.get("index.json");
  h.fake.failure = { method: "PUT", path: "index.json", status: 503 };
  await assert.rejects(h.service.upload({ data: transcript("second"), target: h.uploaded.backupID, expectedToken: (await h.service.snapshot()).token }), /503/);
  assert.equal(h.fake.files.get("index.json"), before);
  assert.equal((await h.service.scan()).paths.length, 1);
});
test("invalid/missing index never triggers destructive recovery", async () => {
  const h = await firstUpload();
  h.fake.files.set("index.json", "broken");
  await assert.rejects(h.service.snapshot(), /不是有效 JSON/);
  h.fake.files.delete("index.json");
  await assert.rejects(h.service.scan(), /索引缺失/);
  await assert.rejects(h.service.upload({ data: transcript(), expectedToken: (await h.service.snapshot()).token }), /索引缺失/);
  assert.equal(h.fake.files.size, 1);
});
test("orphan cleanup ignores foreign files and rejects changed preview", async () => {
  const h = await firstUpload();
  const folder = `sessions/${h.uploaded.backupID}`;
  h.fake.files.set(`${folder}/notes.json`, "foreign");
  const orphan = filePath(h.uploaded.backupID, id("r"));
  h.fake.files.set(orphan, "{}");
  const scan = await h.service.scan();
  assert.deepEqual(scan.paths, [orphan]);
  h.fake.files.set(filePath(h.uploaded.backupID, id("r")), "{}");
  await assert.rejects(h.service.clean({ expectedToken: scan.token, scanToken: scan.scanToken }), /已变化/);
  assert.equal(h.fake.files.has(orphan), true);
});
test("same-process concurrent operations cannot interleave", async () => {
  const h = await firstUpload();
  const token = (await h.service.snapshot()).token;
  const results = await Promise.allSettled([
    h.service.edit({ backupID: h.uploaded.backupID, title: "a", expectedToken: token }),
    h.service.remove({ backupID: h.uploaded.backupID, expectedToken: token }),
  ]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(results.filter((r) => r.status === "rejected").length, 1);
});
test("max backup bytes prevents any remote PUT", async () => {
  const h = harness();
  h.cfg.maxBackupBytes = 1024;
  await assert.rejects(h.service.upload({ data: transcript("x".repeat(2048)), expectedToken: (await h.service.snapshot()).token }), /超过/);
  assert.equal(h.fake.trace.some((r) => r.method === "PUT"), false);
});
test("bindings are namespaced by remote and readonly test does not write", async () => {
  const h = await firstUpload();
  const cfg = { ...h.cfg, root: "different" };
  const other = new BackupService(new (h.dav.constructor as typeof import("../src/webdav.js").WebDAV)(cfg, h.fake.fetch), {
    get: async (key) => h.store.get(key), set: async () => {},
  }, "2.2.6", "/target");
  assert.equal(await other.binding("ses_original"), undefined);
  h.fake.trace.length = 0;
  assert.equal((await h.service.test()).ok, true);
  assert.equal(h.fake.trace.some((r) => ["PUT", "DELETE", "MKCOL"].includes(r.method)), false);
});
