import { Plugin } from "@opencode/plugin";
import { configPath, loadConfig, readSettings, saveSettings } from "./config.js";
import { SyncError } from "./model.js";
import { WebdavRPC } from "./rpc.js";
import { BackupService } from "./service.js";
import { WebDAV } from "./webdav.js";

export default Plugin.define({
  id: "webdav-sync",
  async setup(ctx) {
    const file = configPath(typeof ctx.options.configPath === "string" ? ctx.options.configPath : undefined);
    // Lazy loading lets OpenCode start without configured WebDAV; reload the file on each action.
    const service = async () => {
      const loaded = await loadConfig(file);
      return { service: new BackupService(new WebDAV(loaded.config), {
        get: (key) => ctx.storage.get(key),
        set: (key, value) => ctx.storage.set(key, value),
      }, ctx.app.version, ctx.location.directory), warning: loaded.warning };
    };
    const protect = async <T>(fn: () => Promise<T>, context: { error: (type: "operation_failed", message: string, data: { code: string }) => unknown }): Promise<T> => {
      // The RPC transport validates strict JSON; optional undefined fields must be omitted.
      try { return JSON.parse(JSON.stringify(await fn())) as T; }
      catch (error) {
        const safe = error instanceof SyncError ? error : new SyncError("operation_failed", "操作失败。可能是配置、插件存储或服务器异常；为避免泄露凭据，不展示原始错误。");
        throw context.error("operation_failed", safe.message, { code: safe.code });
      }
    };
    await ctx.rpc.register(WebdavRPC, {
      settings: (_input, context) => protect(() => readSettings(file, ctx.location.directory), context),
      saveSettings: (input, context) => protect(() => saveSettings(file, ctx.location.directory, input), context),
      overview: (input, context) => protect(async () => {
        const loaded = await service();
        return { ...await loaded.service.overview(input.sessionID, context.signal), configFile: file, warning: loaded.warning };
      }, context),
      upload: (input, context) => protect(async () => (await service()).service.upload(input, context.signal), context),
      download: (input, context) => protect(async () => (await service()).service.download(input, context.signal), context),
      remember: (input, context) => protect(async () => {
        await (await service()).service.rememberDownloaded(input, context.signal);
        return { ok: true as const };
      }, context),
      edit: (input, context) => protect(async () => (await service()).service.edit(input, context.signal), context),
      remove: (input, context) => protect(async () => (await service()).service.remove(input, context.signal), context),
      scan: (_input, context) => protect(async () => (await service()).service.scan(context.signal), context),
      clean: (input, context) => protect(async () => (await service()).service.clean(input, context.signal), context),
      test: (_input, context) => protect(async () => (await service()).service.test(context.signal), context),
    });
  },
});
