import { test } from "node:test";
import assert from "node:assert/strict";
import { WebDAV } from "../src/webdav.js";
import { config, FakeDAV, harness } from "./helpers.js";

test("Basic authentication is sent with redirects disabled and traversal rejected", async () => {
  const cfg = config();
  const dav = new WebDAV(cfg, async (_url, init) => {
    assert.equal(init?.redirect, "error");
    assert.equal(new Headers(init?.headers).get("authorization"), `Basic ${Buffer.from("alice:very-secret").toString("base64")}`);
    return new Response(null, { status: 404 });
  });
  await dav.get("index.json");
  for (const path of ["../secret", "a/%2e%2e/secret", "a\\secret", "a//b", "a?secret"]) assert.throws(() => dav.url(path));
});
test("HTTP errors never echo response body or credentials", async () => {
  const dav = new WebDAV(config(), async () => new Response("very-secret server traceback", { status: 401 }));
  await assert.rejects(dav.get("index.json"), (error: Error) => error.message.includes("401") && !error.message.includes("very-secret"));
});
test("network failures are redacted", async () => {
  const dav = new WebDAV(config(), async () => { throw new Error("very-secret"); });
  await assert.rejects(dav.get("index.json"), (error: Error) => !error.message.includes("very-secret"));
});
test("streaming responses enforce byte limits", async () => {
  const dav = new WebDAV(config(), async () => new Response("x".repeat(2048)));
  await assert.rejects(dav.get("index.json", undefined, 1024), /超过/);
});
test("PROPFIND parses namespaced collections and ignores escaped traversal/foreign origins", async () => {
  const fake = new FakeDAV();
  fake.directories.add("sessions");
  fake.files.set("index.json", "{}");
  const dav = new WebDAV(config(), fake.fetch);
  const rows = await dav.list("");
  assert.deepEqual(rows.sort((a, b) => a.path.localeCompare(b.path)), [
    { path: "index.json", collection: false }, { path: "sessions", collection: true },
  ]);
  fake.xml = '<d:multistatus xmlns:d="DAV:"><d:response><d:href>https://evil.test/dav/backups/index.json</d:href></d:response>'
    + '<d:response><d:href>/dav/backups/sessions%2f..%2fsecret</d:href></d:response></d:multistatus>';
  assert.deepEqual(await dav.list(""), []);
});
test("PROPFIND rejects unsafe XML and missing property statuses", async () => {
  const h = harness();
  h.fake.xml = '<!DOCTYPE a [<!ENTITY x "secret">]><d:multistatus xmlns:d="DAV:"/>';
  await assert.rejects(h.dav.list(""), /XML/);
  h.fake.xml = '<d:multistatus xmlns:d="DAV:"><d:response><d:href>/dav/backups/file.json</d:href></d:response></d:multistatus>';
  await assert.rejects(h.dav.list(""), /属性/);
});
