import { test } from "node:test";
import assert from "node:assert/strict";
import type { Plugin } from "@opencode/plugin/tui";
import tui from "../src/tui.js";
import type { Transfer } from "../src/model.js";
import { classificationSchema, normalizeDirectory } from "../src/config.js";
import { firstUpload, harness, transcript } from "./helpers.js";

async function uiHarness(h = harness(), selections: string[] = [], confirmations: boolean[] = [], prompts: string[] = []) {
  const alerts: Array<{ title: string; message: string }> = [];
  const navigations: Array<{ type: string; sessionID?: string }> = [];
  const exports: string[] = [];
  const imports: Transfer[] = [];
  let run: (() => Promise<void>) | undefined;
  let running = false;
  let importFails = false;
  let active: string | undefined = "ses_active";
  let settingsVersion = 0;
  const localSettings = () => {
    const currentWorkspaceIndex = h.cfg.workspaces.findIndex((w) => normalizeDirectory(w.directory) === normalizeDirectory("D:/target"));
    return { projects: structuredClone(h.cfg.projects), workspaces: structuredClone(h.cfg.workspaces), token: `settings-${settingsVersion}`,
      configFile: "/private/config.json", directory: "D:/target", currentWorkspaceIndex,
      defaultProject: h.cfg.workspaces[currentWorkspaceIndex]?.project };
  };
  const rpc = {
    settings: async () => localSettings(),
    saveSettings: async (input: { projects: string[]; workspaces: Array<{ directory: string; project: string }>; expectedToken: string }) => {
      assert.equal(input.expectedToken, `settings-${settingsVersion}`);
      const parsed = classificationSchema.parse(input);
      h.cfg.projects = parsed.projects;
      h.cfg.workspaces = parsed.workspaces;
      settingsVersion++;
      return localSettings();
    },
    overview: async (input: { sessionID?: string }) => ({ ...await h.service.overview(input.sessionID), configFile: "/private/config.json" }),
    upload: (input: Parameters<typeof h.service.upload>[0]) => h.service.upload(input),
    download: (input: Parameters<typeof h.service.download>[0]) => h.service.download(input),
    edit: (input: Parameters<typeof h.service.edit>[0]) => h.service.edit(input),
    remove: (input: Parameters<typeof h.service.remove>[0]) => h.service.remove(input),
    scan: () => h.service.scan(),
    clean: (input: Parameters<typeof h.service.clean>[0]) => h.service.clean(input), test: () => h.service.test(),
    remember: async (input: Parameters<typeof h.service.rememberDownloaded>[0]) => {
      await h.service.rememberDownloaded(input); return { ok: true };
    },
  };
  await tui.setup({
    location: { directory: "D:/target" },
    client: { rpc: () => rpc, experimental: { session: {
      export: async (input: { sessionID: string }) => { exports.push(input.sessionID); return transcript("active only", input.sessionID); },
      import: async (input: Transfer) => { if (importFails) throw new Error("raw sensitive error"); imports.push(input); return { id: input.info.id }; },
    } } },
    data: { session: { status: () => running ? "running" : "idle", invalidate: () => {} } },
    ui: {
      dialog: {
        select: async () => selections.shift(),
        confirm: async () => confirmations.shift() ?? true,
        alert: async (value: { title: string; message: string }) => { alerts.push(value); },
        prompt: async () => prompts.shift(),
      },
      toast: { show: () => {} },
      router: { current: () => active ? { type: "session", sessionID: active } : { type: "home" },
        navigate: (destination: { type: string; sessionID?: string }) => { navigations.push(destination); } },
    },
    keymap: { layer: (factory: () => { commands: Array<{ run: () => Promise<void> }> }) => { run = factory().commands[0]!.run; } },
  } as unknown as Plugin.Context);
  return { ...h, alerts, navigations, exports, imports, run: async () => { assert.ok(run); await run(); },
    setRunning: (value: boolean) => { running = value; }, setActive: (value?: string) => { active = value; },
    failImport: () => { importFails = true; } };
}

test("TUI upload exports only captured active session through official client", async () => {
  const h = await uiHarness(harness(), ["upload", "none"]);
  await h.run();
  assert.deepEqual(h.exports, ["ses_active"]);
  const snapshot = await h.service.snapshot();
  assert.equal(snapshot.index.sessions.length, 1);
  assert.equal(snapshot.index.sessions[0]!.revisions[0]!.sourceSessionID, "ses_active");
  assert.deepEqual(h.alerts, []);
});
test("TUI canceled upload never exports or writes", async () => {
  const h = await uiHarness(harness(), ["upload", "none"], [false]);
  await h.run();
  assert.deepEqual(h.exports, []);
  assert.equal(h.fake.files.size, 0);
});
test("TUI blocks uploads without active session or while running", async () => {
  for (const mode of ["home", "running"]) {
    const h = await uiHarness(harness(), ["upload"]);
    if (mode === "home") h.setActive(); else h.setRunning(true);
    await h.run();
    assert.deepEqual(h.exports, []);
    assert.equal(h.alerts.length, 1);
  }
});
test("TUI download imports fresh IDs and switches only after successful import", async () => {
  const seeded = await firstUpload();
  const h = await uiHarness(seeded, ["browse", "all", seeded.uploaded.backupID, "latest", "switch"]);
  await h.run();
  assert.equal(h.imports.length, 1);
  const imported = h.imports[0]!;
  assert.notEqual(imported.info.id, "ses_original");
  assert.notEqual(imported.messages[0]!.id, "msg_original");
  assert.equal(imported.info.location.directory, "D:/target");
  assert.deepEqual(h.navigations, [{ type: "session", sessionID: imported.info.id }]);
  assert.equal((await h.service.binding(imported.info.id))?.chooseOnUpload, true);
  assert.equal((await h.service.snapshot()).index.sessions[0]!.revisions.length, 1);
});
test("TUI create-only download does not navigate away from original", async () => {
  const seeded = await firstUpload();
  const h = await uiHarness(seeded, ["browse", "all", seeded.uploaded.backupID, "latest", "create"]);
  await h.run();
  assert.equal(h.imports.length, 1);
  assert.deepEqual(h.navigations, []);
});
test("TUI native import failure keeps original and does not echo sensitive errors", async () => {
  const seeded = await firstUpload();
  const h = await uiHarness(seeded, ["browse", "all", seeded.uploaded.backupID, "latest", "switch"]);
  h.failImport();
  await h.run();
  assert.deepEqual(h.navigations, []);
  assert.equal(h.alerts.length, 1);
  assert.ok(h.alerts[0]!.message.includes("官方导入失败"));
  assert.ok(!h.alerts[0]!.message.includes("sensitive"));
});

test("TUI creates local projects without any WebDAV requests", async () => {
  const h = await uiHarness(harness(), ["settings", "projects", "add"], [], ["my-app"]);
  await h.run();
  assert.deepEqual(h.cfg.projects, ["my-app"]);
  assert.deepEqual(h.fake.trace, []);
  assert.deepEqual(h.alerts, []);
});
test("TUI binds current workspace to a newly created project", async () => {
  const h = await uiHarness(harness(), ["settings", "current-workspace", "set", "new"], [], ["new-project"]);
  await h.run();
  assert.deepEqual(h.cfg.projects, ["new-project"]);
  assert.deepEqual(h.cfg.workspaces, [{ directory: "D:/target", project: "new-project" }]);
  assert.deepEqual(h.fake.trace, []);
});
test("TUI project rename updates local mappings but never remote history", async () => {
  const seeded = await firstUpload();
  seeded.cfg.projects = ["my-app"];
  seeded.cfg.workspaces = [{ directory: "D:/target", project: "my-app" }, { directory: "/other", project: "my-app" }];
  const originalIndex = seeded.fake.files.get("index.json");
  seeded.fake.trace.length = 0;
  const h = await uiHarness(seeded, ["settings", "projects", "rename", "my-app"], [], ["renamed"]);
  await h.run();
  assert.deepEqual(h.cfg.projects, ["renamed"]);
  assert.ok(h.cfg.workspaces.every((w) => w.project === "renamed"));
  assert.equal(h.fake.files.get("index.json"), originalIndex);
  assert.deepEqual(h.fake.trace, []);
});
test("TUI project deletion removes local mappings only after confirmation", async () => {
  for (const confirm of [false, true]) {
    const h = harness();
    h.cfg.projects = ["app", "other"];
    h.cfg.workspaces = [{ directory: "D:/target", project: "app" }];
    const ui = await uiHarness(h, ["settings", "projects", "delete", "app"], [confirm]);
    await ui.run();
    assert.deepEqual(h.cfg.projects, confirm ? ["other"] : ["app", "other"]);
    assert.equal(h.cfg.workspaces.length, confirm ? 0 : 1);
  }
});
test("TUI can add arbitrary workspace mappings and remove current one without deleting project", async () => {
  const h = harness();
  h.cfg.projects = ["app"];
  const add = await uiHarness(h, ["settings", "workspaces", "add", "project:0"], [], ["D:/target"]);
  await add.run();
  assert.deepEqual(h.cfg.workspaces, [{ directory: "D:/target", project: "app" }]);
  const remove = await uiHarness(h, ["settings", "current-workspace", "remove"]);
  await remove.run();
  assert.deepEqual(h.cfg.workspaces, []);
  assert.deepEqual(h.cfg.projects, ["app"]);
});
test("TUI edits an existing workspace path and project", async () => {
  const h = harness();
  h.cfg.projects = ["app", "other"];
  h.cfg.workspaces = [{ directory: "D:/old", project: "app" }];
  const ui = await uiHarness(h, ["settings", "workspaces", "workspace:0", "edit", "project:1"], [], ["D:/new"]);
  await ui.run();
  assert.deepEqual(h.cfg.workspaces, [{ directory: "D:/new", project: "other" }]);
  assert.deepEqual(h.fake.trace, []);
  assert.deepEqual(ui.alerts, []);
});
