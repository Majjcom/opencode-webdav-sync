// Opt-in integration test: isolated OpenCode server, no model calls and no real WebDAV.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { OpenCode } from "@opencode/client";
import type { ExperimentalSessionImportInput } from "@opencode/client";
import { freshImport, transferSchema } from "../src/model.js";
import { WebdavRPC } from "../src/rpc.js";
import { transcript } from "../tests/helpers.js";

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageArgument = process.argv.indexOf("--plugin");
const pluginDirectory = packageArgument >= 0 ? path.resolve(process.argv[packageArgument + 1]!) : repository;
const base = process.platform === "win32"
  ? path.join(process.env.LOCALAPPDATA!, "Temp", "opencode") : os.tmpdir();
await mkdir(base, { recursive: true });
const root = await mkdtemp(path.join(base, "webdav-native-"));
const workspace = path.join(root, "workspace");
const configurationDirectory = path.join(root, "active-config");
for (const name of ["workspace", "data", "config/opencode", "active-config", "cache", "state", "tmp", "appdata", "local"])
  await mkdir(path.join(root, name), { recursive: true });
await writeFile(path.join(configurationDirectory, "opencode.json"), JSON.stringify({ update: "disable" }));
await writeFile(path.join(workspace, "opencode.json"), JSON.stringify({ snapshots: false,
  plugins: [{ package: pluginDirectory.replaceAll("\\", "/") }] }));
const portServer = createServer();
await new Promise<void>((resolve) => portServer.listen(0, "127.0.0.1", resolve));
const address = portServer.address();
assert.ok(address && typeof address !== "string");
const port = address.port;
await new Promise<void>((resolve, reject) => portServer.close((error) => error ? reject(error) : resolve()));
const argument = process.argv.indexOf("--binary");
const binary = argument >= 0 ? process.argv[argument + 1]!
  : process.env.OPENCODE_BINARY ?? (process.platform === "win32"
    ? path.join(path.dirname(process.execPath), "node_modules/@opencode/cli/bin/opencode.exe") : "opencode");
const env: NodeJS.ProcessEnv = {};
for (const key of ["PATH", "Path", "SystemRoot", "SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT"])
  if (process.env[key]) env[key] = process.env[key];
Object.assign(env, {
  HOME: root, USERPROFILE: root, APPDATA: path.join(root, "appdata"), LOCALAPPDATA: path.join(root, "local"),
  XDG_DATA_HOME: path.join(root, "data"), XDG_CONFIG_HOME: path.join(root, "config"),
  XDG_CACHE_HOME: path.join(root, "cache"), XDG_STATE_HOME: path.join(root, "state"),
  TMPDIR: path.join(root, "tmp"), TMP: path.join(root, "tmp"), TEMP: path.join(root, "tmp"),
  OPENCODE_DB: path.join(root, "data", "smoke.db"),
  OPENCODE_CONFIG_DIR: configurationDirectory,
});
const child = spawn(binary, ["serve", "--hostname", "127.0.0.1", "--port", String(port), "--log-level", "debug", "--print-logs"], { cwd: workspace, env, stdio: ["ignore", "pipe", "pipe"] });
let logs = "";
let spawnError: Error | undefined;
child.on("error", (error) => { spawnError = error; });
child.stdout.on("data", (data) => { logs = (logs + data).slice(-20000); });
child.stderr.on("data", (data) => { logs = (logs + data).slice(-20000); });
const safeLogs = () => logs.replace(/server password [^\r\n]+/g, "server password [REDACTED]");
let client = OpenCode.make({ baseUrl: `http://127.0.0.1:${port}` });
try {
  const deadline = Date.now() + 60000;
  let ready = false;
  while (Date.now() < deadline) {
    if (spawnError) throw spawnError;
    if (child.exitCode !== null) throw new Error(`OpenCode exited: ${safeLogs()}`);
    const password = logs.match(/server password ([^\r\n]+)/)?.[1];
    if (password) client = OpenCode.make({ baseUrl: `http://127.0.0.1:${port}`,
      headers: { authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}` } });
    try { await client.server.info({ signal: AbortSignal.timeout(1000) }); ready = true; break; } catch { await delay(200); }
  }
  assert.ok(ready, `OpenCode startup timed out: ${safeLogs()}`);
  const info = await client.server.info();
  console.log("Isolated server ready:", JSON.stringify(info));
  await client.config.get({ location: { directory: workspace } });
  await client.session.create({ location: { directory: workspace }, title: "Isolated plugin activation" });
  const rpc = client.rpc(WebdavRPC);
  await assert.rejects(rpc.overview({}, { location: { directory: workspace } }), (error: unknown) => {
    return typeof error === "object" && error !== null && "type" in error && error.type === "operation_failed"
      && "data" in error && typeof error.data === "object" && error.data !== null
      && "code" in error.data && error.data.code === "config_missing";
  });
  const requestOptions = { location: { directory: workspace } };
  const initialSettings = await rpc.settings({}, requestOptions);
  const nativeConfigDirectory = execFileSync(binary, ["debug", "paths", "config"], { cwd: workspace, env, encoding: "utf8" }).trim();
  assert.equal(initialSettings.configFile, path.join(nativeConfigDirectory, "webdav-sync.json"));
  const configured = await rpc.saveSettings({ projects: ["native-project"], workspaces: [{ directory: workspace, project: "native-project" }],
    expectedToken: initialSettings.token }, requestOptions);
  assert.equal(configured.defaultProject, "native-project");
  assert.equal(configured.currentWorkspaceIndex, 0);
  const privateDocument = { ...JSON.parse(await readFile(configured.configFile, "utf8")), username: "test-user", password: "test-secret-not-for-webdav" };
  await writeFile(configured.configFile, JSON.stringify(privateDocument));
  const edited = await rpc.settings({}, requestOptions);
  const saved = await rpc.saveSettings({ projects: ["renamed-project"], workspaces: [{ directory: workspace, project: "renamed-project" }],
    expectedToken: edited.token }, requestOptions);
  assert.ok(!JSON.stringify(saved).includes(privateDocument.password));
  assert.equal(JSON.parse(await readFile(configured.configFile, "utf8")).password, privateDocument.password);
  const { data: plugins } = await client.plugin.list({ location: { directory: workspace } });
  assert.ok(plugins.some((p) => p.id === "webdav-sync"), `Plugin not loaded: ${JSON.stringify(plugins)}\n${safeLogs()}`);
  const fixture = transcript("native roundtrip without model calls");
  fixture.messages.push({ id: "msg_assistant", type: "assistant", agent: "build",
    model: { providerID: "example", id: "example-model" }, time: { created: 2, completed: 3 },
    content: [
      { type: "text", text: "historical assistant reply" },
      { type: "tool", id: "historical-call", name: "read", executed: true,
        time: { created: 2, ran: 2, completed: 3 }, state: { status: "completed", input: { path: "not-executed.txt" },
          content: [{ type: "text", text: "historical tool output" }] } },
    ] });
  fixture.messages.push({ id: "msg_compaction", type: "compaction", status: "completed", reason: "manual",
    summary: "historical summary", time: { created: 4 } });
  const original = freshImport(fixture, workspace);
  const first = await client.experimental.session.import({ ...original, location: { directory: workspace } } as unknown as ExperimentalSessionImportInput);
  const exported = transferSchema.parse(await client.experimental.session.export({ sessionID: first.id }));
  assert.equal(exported.messages[0]!.text, original.messages[0]!.text);
  assert.equal(exported.messages.length, 3);
  const ids = new Set([first.id]);
  for (let i = 0; i < 2; i++) {
    const copy = freshImport(exported, workspace);
    const created = await client.experimental.session.import({ ...copy, location: { directory: workspace } } as unknown as ExperimentalSessionImportInput);
    assert.equal(created.id, copy.info.id);
    assert.ok(!ids.has(created.id));
    ids.add(created.id);
    const result = await client.experimental.session.export({ sessionID: created.id });
    assert.equal(result.messages[0]!.id, copy.messages[0]!.id);
    assert.equal((result.messages[0] as { text?: string }).text, original.messages[0]!.text);
    assert.deepEqual(result.messages.map(({ id: _id, ...message }) => message), exported.messages.map(({ id: _id, ...message }) => message));
  }
  const sanitized = await client.experimental.session.export({ sessionID: first.id, sanitize: true });
  assert.notEqual((sanitized.messages[0] as { text?: string }).text, original.messages[0]!.text);
  const sourceAgain = await client.experimental.session.export({ sessionID: first.id });
  assert.equal(sourceAgain.messages[0]!.id, original.messages[0]!.id);
  console.log("PASS: real plugin/RPC loading, native config directory, UI settings persistence, credential preservation, official export/import, repeated fresh IDs, sanitize, original unchanged.");
  console.log("Isolated test data retained at:", root);
} catch (error) {
  console.error("Isolated server output:", safeLogs());
  throw error;
} finally {
  child.kill();
  if (child.exitCode === null) await Promise.race([new Promise((resolve) => child.once("exit", resolve)), delay(5000)]);
}
