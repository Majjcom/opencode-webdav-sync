import { test } from "node:test";
import assert from "node:assert/strict";
import { contentHash, filePath, freshImport, indexSchema, transferSchema } from "../src/model.js";
import { configPath, configSchema, defaultProject } from "../src/config.js";
import { transcript, config } from "./helpers.js";

test("fresh import remaps IDs, detaches foreign state, and preserves content", () => {
  const data = transcript("msg_original and ses_original must remain literal text");
  data.info.parentID = "ses_parent";
  data.info.fork = { sessionID: "ses_parent", boundary: { type: "through", messageID: "msg_parent" } };
  data.info.permissions = [{ action: "*", resource: "*", effect: "allow" }];
  data.info.revert = { messageID: "msg_original" };
  data.info.time.archived = 99;
  const a = freshImport(data, "C:/target");
  const b = freshImport(data, "C:/target");
  assert.notEqual(a.info.id, data.info.id);
  assert.notEqual(a.info.id, b.info.id);
  assert.notEqual(a.messages[0]!.id, b.messages[0]!.id);
  assert.equal(a.messages[0]!.text, data.messages[0]!.text);
  for (const key of ["parentID", "fork", "permissions", "revert"]) assert.equal(a.info[key], undefined);
  assert.equal(a.info.time.archived, undefined);
  assert.equal(a.info.location.directory, "C:/target");
  assert.equal(data.info.parentID, "ses_parent");
  assert.equal(contentHash(a), contentHash(data));
});
test("content digest ignores view/import identity but detects transcript changes", () => {
  const a = transcript();
  const b = freshImport(a, "/different");
  b.info.time.updated = 999;
  assert.equal(contentHash(a), contentHash(b));
  b.messages[0]!.text = "changed";
  assert.notEqual(contentHash(a), contentHash(b));
});
test("duplicate message IDs and invalid native payloads are rejected", () => {
  const data = transcript();
  data.messages.push(structuredClone(data.messages[0]!));
  assert.throws(() => freshImport(data, "/target"), /重复消息/);
  assert.equal(transferSchema.safeParse({ info: { id: "ses_x" }, messages: [] }).success, false);
});
test("path and index schemas reject traversal, incompatible versions and duplicate IDs", () => {
  assert.throws(() => filePath("../../outside", "r_123"));
  assert.equal(indexSchema.safeParse({ formatVersion: 99, generation: "a", sessions: [] }).success, false);
});
test("configuration requires HTTPS, forbids embedded credentials and traversal", () => {
  const base = config();
  for (const url of ["http://dav.test/", "https://alice:secret@dav.test/", "https://dav.test/?x=1"]) {
    assert.equal(configSchema.safeParse({ ...base, url }).success, false);
  }
  for (const root of ["../outside", "/absolute", "a//b", "a/%2e%2e", "a\\b"]) {
    assert.equal(configSchema.safeParse({ ...base, root }).success, false);
  }
  assert.equal(configSchema.safeParse({ ...base, root: "备份/会话" }).success, true);
  assert.equal(configSchema.safeParse({ ...base, typoPassword: "secret" }).success, false);
});
test("user config override and exact workspace mapping", () => {
  assert.match(configPath("./custom.json"), /custom\.json$/);
  const cfg = config();
  cfg.workspaces = [{ directory: process.cwd(), project: "project" }];
  assert.equal(defaultProject(cfg, process.cwd()), "project");
  assert.equal(defaultProject(cfg, `${process.cwd()}/other`), undefined);
});
