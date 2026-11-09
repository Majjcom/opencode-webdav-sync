import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { classificationSchema, configPath, loadConfig, readSettings, saveSettings } from "../src/config.js";

async function fixture(run: (file: string, directory: string) => Promise<void>) {
  const base = process.platform === "win32" ? path.join(process.env.LOCALAPPDATA!, "Temp", "opencode") : os.tmpdir();
  await mkdir(base, { recursive: true });
  const directory = await mkdtemp(path.join(base, "webdav-settings-"));
  try { await run(path.join(directory, "webdav-sync.json"), directory); }
  finally { await rm(directory, { recursive: true, force: true }); }
}

test("default config directory follows OPENCODE_CONFIG_DIR then XDG_CONFIG_HOME", () => {
  const keys = ["OPENCODE_CONFIG_DIR", "XDG_CONFIG_HOME", "OPENCODE_WEBDAV_CONFIG"] as const;
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  try {
    delete process.env.OPENCODE_WEBDAV_CONFIG;
    process.env.OPENCODE_CONFIG_DIR = path.resolve("custom-opencode");
    process.env.XDG_CONFIG_HOME = path.resolve("custom-xdg");
    assert.equal(configPath(), path.join(process.env.OPENCODE_CONFIG_DIR, "webdav-sync.json"));
    assert.equal(configPath("explicit.json"), path.resolve("explicit.json"));
    delete process.env.OPENCODE_CONFIG_DIR;
    assert.equal(configPath(), path.join(process.env.XDG_CONFIG_HOME, "opencode", "webdav-sync.json"));
  } finally {
    for (const key of keys) { if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key]; }
  }
});
test("settings can initialize without credentials and never return secret fields", async () => fixture(async (file, directory) => {
  const first = await readSettings(file, directory);
  assert.deepEqual(first.projects, []);
  assert.equal(first.currentWorkspaceIndex, -1);
  const saved = await saveSettings(file, directory, { projects: ["app"], workspaces: [{ directory, project: "app" }], expectedToken: first.token });
  assert.equal(saved.defaultProject, "app");
  assert.equal(saved.currentWorkspaceIndex, 0);
  assert.notEqual(saved.token, first.token);
  assert.deepEqual(JSON.parse(await readFile(file, "utf8")), { projects: ["app"], workspaces: [{ directory, project: "app" }] });
  if (process.platform !== "win32") assert.equal((await stat(file)).mode & 0o777, 0o600);
}));
test("saving classifications preserves credentials and all unrelated JSON values", async () => fixture(async (file, directory) => {
  const document = { url: "https://dav.test/", username: "user", password: "KEEP-this-secret", device: "my-device",
    timeoutMs: 45000, sanitize: true, customFutureOption: { retain: [1, true, null] }, projects: ["old"], workspaces: [] };
  await writeFile(file, JSON.stringify(document));
  const before = await readSettings(file, directory);
  assert.ok(!JSON.stringify(before).includes(document.password));
  const saved = await saveSettings(file, directory, { projects: ["new"], workspaces: [{ directory, project: "new" }], expectedToken: before.token });
  assert.ok(!JSON.stringify(saved).includes(document.password));
  const persisted = JSON.parse(await readFile(file, "utf8"));
  assert.deepEqual(persisted, { ...document, projects: ["new"], workspaces: [{ directory, project: "new" }] });
  assert.deepEqual(await readdir(directory), ["webdav-sync.json"]);
}));
test("manual concurrent edits invalidate settings confirmation without overwriting", async () => fixture(async (file, directory) => {
  const view = await readSettings(file, directory);
  const changed = JSON.stringify({ password: "manually-updated", projects: ["external"] });
  await writeFile(file, changed);
  await assert.rejects(saveSettings(file, directory, { projects: ["UI"], workspaces: [], expectedToken: view.token }), /已变化/);
  assert.equal(await readFile(file, "utf8"), changed);
  assert.deepEqual(await readdir(directory), ["webdav-sync.json"]);
}));
test("malformed JSON and invalid mapping input are never overwritten", async () => fixture(async (file, directory) => {
  await writeFile(file, "not json");
  await assert.rejects(readSettings(file, directory), /不会覆盖/);
  assert.equal(await readFile(file, "utf8"), "not json");
  await writeFile(file, "{}");
  const view = await readSettings(file, directory);
  await assert.rejects(saveSettings(file, directory, { projects: ["same", "same"], workspaces: [], expectedToken: view.token }), /不可重复/);
  await assert.rejects(saveSettings(file, directory, { projects: [], workspaces: [{ directory: "relative/path", project: "app" }], expectedToken: view.token }), /绝对路径/);
  assert.equal(await readFile(file, "utf8"), "{}");
}));
test("normalized duplicate workspace paths are rejected", () => {
  const directory = path.resolve("workspace");
  assert.equal(classificationSchema.safeParse({ projects: [], workspaces: [
    { directory, project: "a" }, { directory: `${directory}${path.sep}`, project: "b" },
  ] }).success, false);
});
test("persisted UI defaults are consumed by normal connection config loading", async () => fixture(async (file, directory) => {
  await writeFile(file, JSON.stringify({ url: "https://dav.test/", username: "user", password: "secret" }));
  const view = await readSettings(file, directory);
  await saveSettings(file, directory, { projects: ["app"], workspaces: [{ directory, project: "app" }], expectedToken: view.token });
  const { config } = await loadConfig(file);
  assert.deepEqual(config.projects, ["app"]);
  assert.equal(config.password, "secret");
}));
test("concurrent UI saves cannot silently overwrite one another", async () => fixture(async (file, directory) => {
  const view = await readSettings(file, directory);
  const results = await Promise.allSettled([
    saveSettings(file, directory, { projects: ["first"], workspaces: [], expectedToken: view.token }),
    saveSettings(file, directory, { projects: ["second"], workspaces: [], expectedToken: view.token }),
  ]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(results.filter((r) => r.status === "rejected").length, 1);
  assert.equal((await readSettings(file, directory)).projects.length, 1);
  assert.deepEqual(await readdir(directory), ["webdav-sync.json"]);
}));
