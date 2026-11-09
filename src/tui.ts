import { Plugin } from "@opencode/plugin/tui";
import type { ExperimentalSessionImportInput } from "@opencode/client";
import { freshImport, SyncError, transferSchema, versionWarnings } from "./model.js";
import type { Entry, Revision } from "./model.js";
import { WebdavRPC } from "./rpc.js";

export default Plugin.define({
  id: "webdav-sync.tui",
  setup(ctx) {
    const rpc = ctx.client.rpc(WebdavRPC);
    let running = false;
    let disposed = false;
    let controller: AbortController | undefined;

    async function open() {
      if (running) { ctx.ui.toast.show({ message: "WebDAV 操作正在执行。", variant: "warning" }); return; }
      running = true;
      controller = new AbortController();
      const location = ctx.location ?? ctx.data.location.default();
      const options = { location, signal: controller.signal };
      const route = ctx.ui.router.current();
      const sessionID = route.type === "session" ? route.sessionID : undefined;
      const dialog = ctx.ui.dialog;
      const overview = () => rpc.overview({ sessionID }, options);
      type Overview = Awaited<ReturnType<typeof overview>>;
      const success = (message: string) => ctx.ui.toast.show({ title: "WebDAV", message, variant: "success" });

      async function chooseProject(view: Overview, initial?: string): Promise<{ value?: string } | undefined> {
        const projects = [...new Set([...view.settings.projects, ...view.index.sessions.flatMap((s) => s.project ? [s.project] : []),
          ...(initial ? [initial] : [])])].sort();
        const selected = await dialog.select({ title: `项目标签（当前：${initial ?? "未分类"}）`,
          options: [
            { title: "未分类", value: "none" },
            ...projects.map((p, i) => ({ title: p, value: `project:${i}` })),
            { title: "输入其他项目标签…", value: "custom" },
          ] });
        if (selected === undefined) return;
        if (selected === "none") return {};
        if (selected === "custom") {
          const value = await dialog.prompt({ title: "项目标签", value: initial, placeholder: "例如 my-app" });
          if (value === undefined) return;
          if (!value.trim() || value.trim().length > 200) throw new SyncError("input", "项目标签需要 1–200 个字符。");
          return { value: value.trim() };
        }
        return { value: projects[Number(selected.slice(8))] };
      }

      async function confirmVersions(revision: Revision, view: Overview): Promise<boolean> {
        const warnings = versionWarnings(revision, view.settings.opencodeVersion);
        return !warnings.length || (await dialog.confirm({ title: "版本不一致，需要手动确认",
          message: `${warnings.join("\n")}\n格式兼容不代表所有行为一致。是否继续？` })) === true;
      }

      async function download(view: Overview, entry: Entry, selected?: Revision) {
        const revisionID = selected?.id ?? await dialog.select({ title: `下载历史：${entry.title}`,
          options: [...entry.revisions].reverse().map((r) => ({ title: `${r.createdAt} · ${r.device}`,
            value: r.id, description: `${r.bytes} bytes · OpenCode ${r.opencodeVersion}${r.sanitize ? " · 已脱敏" : ""}` })) });
        if (!revisionID) return;
        const revision = entry.revisions.find((r) => r.id === revisionID)!;
        if (!await confirmVersions(revision, view)) return;
        const mode = await dialog.select({ title: "下载到当前工作区（原 session 不变）", options: [
          { title: "创建新 session 并切换", value: "switch" },
          { title: "仅创建新 session", value: "create" },
        ] });
        if (!mode) return;
        if (!await dialog.confirm({ title: "确认导入",
          message: `备份：${entry.title}\n版本：${revision.createdAt}\n目标：${location.directory}\n`
            + "会话和消息将获得新 ID；不导入父子关系、文件回滚状态或已保存的权限规则。不会恢复工作区代码或执行历史工具。"
            + (revision.sanitize ? "\n注意：此版本已脱敏，正文和工具输出可能已被清除，不是完整恢复。" : "") })) return;
        ctx.ui.toast.show({ message: "正在下载并校验备份…", variant: "info" });
        const result = await rpc.download({ backupID: entry.id, revisionID, expectedToken: view.token, allowVersionMismatch: true }, options);
        const data = freshImport(result.data, location.directory);
        let created: { id: string };
        try {
          created = await ctx.client.experimental.session.import({
            ...data, location: { directory: location.directory },
          } as unknown as ExperimentalSessionImportInput, { signal: options.signal });
        } catch {
          throw new SyncError("native_import", "OpenCode 官方导入失败或请求中断。原活动 session 未修改；若服务器已提交，请先检查会话列表，避免重复导入。当前已验证 API 版本为 2.2.6。");
        }
        if (created.id !== data.info.id) throw new SyncError("native_import", "官方导入返回了非预期 session ID，请检查会话列表；不会修改原 session。");
        try { await rpc.remember({ sessionID: created.id, backupID: entry.id, revisionID, expectedToken: view.token }, options); }
        catch { ctx.ui.toast.show({ message: "新会话已导入，但保存来源关联失败；后续上传将新建备份条目。", variant: "warning" }); }
        ctx.data.session.invalidate(created.id);
        if (mode === "switch" && !disposed) ctx.ui.router.navigate({ type: "session", sessionID: created.id });
        success(`已创建 ${created.id}`);
      }

      async function upload() {
        if (!sessionID) throw new SyncError("no_session", "请先打开要上传的 session。");
        if (ctx.data.session.status(sessionID) === "running") throw new SyncError("session_busy", "当前 session 正在运行，请等待空闲后上传。");
        const view = await overview();
        let entry = view.binding ? view.index.sessions.find((s) => s.id === view.binding!.backupID) : undefined;
        if (view.binding && !entry) {
          if (!await dialog.confirm({ title: "原备份已删除", message: "原备份条目已不存在，是否为当前 session 新建备份？" })) return;
        } else if (entry && view.binding?.chooseOnUpload) {
          const choice = await dialog.select({ title: "下载会话的首次上传", options: [
            { title: "继续原备份历史", value: "continue", description: entry.title },
            { title: "另建备份条目", value: "new" },
          ] });
          if (!choice) return;
          if (choice === "new") entry = undefined;
        }
        let allowConflict = false;
        const latest = entry?.revisions.at(-1);
        if (entry && latest) {
          if (!await confirmVersions(latest, view)) return;
          if (view.binding?.baseRevision !== latest.id) {
            const choice = await dialog.select({ title: "远端已推进：请手动处理", options: [
              { title: "以本地为准，追加新历史版本", value: "local", description: "保留所有远端旧版本，不合并正文" },
              { title: "以远端为准，下载为新 session", value: "remote", description: "不会覆盖当前 session" },
              { title: "本地另建备份条目", value: "new" },
              { title: "取消", value: "cancel" },
            ] });
            if (!choice || choice === "cancel") return;
            if (choice === "remote") return download(view, entry, latest);
            if (choice === "new") entry = undefined;
            else allowConflict = true;
          }
        }
        const project = await chooseProject(view, entry?.project ?? view.settings.defaultProject);
        if (!project) return;
        if (!await dialog.confirm({ title: "上传当前 session",
          message: `设备：${view.settings.device}\n项目：${project.value ?? "未分类"}\n`
            + (view.settings.sanitize ? "已启用官方 sanitize：正文、工具输入输出等将被清除，不能完整恢复。"
              : "将上传官方完整导出内容，可能包含提示词、源代码、工具输出及敏感信息。")
            + "\n仅上传当前会话，不包含其他会话或工作区文件。请确保其他设备未在写入此服务器。"
            + (view.warning ? `\n${view.warning}` : "") })) return;
        ctx.ui.toast.show({ message: "正在导出并上传当前 session…", variant: "info" });
        let data;
        try { data = transferSchema.parse(await ctx.client.experimental.session.export({ sessionID, sanitize: view.settings.sanitize }, { signal: options.signal })); }
        catch { throw new SyncError("native_export", "OpenCode 官方导出失败；当前已验证 API 版本为 2.2.6。"); }
        if (ctx.data.session.status(sessionID) === "running") throw new SyncError("session_busy", "导出期间 session 开始运行，请空闲后重试。");
        if (data.info.id !== sessionID) throw new SyncError("native_export", "官方导出的 session ID 不匹配，已取消上传。");
        const result = await rpc.upload({ data, target: entry?.id, project: project.value, expectedToken: view.token,
          allowConflict, allowVersionMismatch: true }, options);
        success(result.status === "unchanged" ? "内容未变化，未创建重复版本。" : "当前 session 已备份。所有历史版本均保留。");
      }

      async function browse() {
        const view = await overview();
        if (!view.index.sessions.length) { await dialog.alert({ title: "备份列表", message: "暂无远端备份。请先上传当前 session。" }); return; }
        const projects = [...new Set([...view.settings.projects, ...view.index.sessions.flatMap((s) => s.project ? [s.project] : [])])].sort();
        const filter = await dialog.select({ title: "按项目筛选", options: [
          { title: "全部项目", value: "all" }, { title: "未分类", value: "none" },
          ...projects.map((p, i) => ({ title: p, value: `project:${i}` })),
        ] });
        if (!filter) return;
        const sessions = view.index.sessions.filter((s) => filter === "all" || (filter === "none" ? !s.project : s.project === projects[Number(filter.slice(8))]));
        if (!sessions.length) { await dialog.alert({ title: "项目筛选", message: "该项目暂无备份。" }); return; }
        const selected = await dialog.select({ title: "远端备份（可搜索标题、项目）", options: sessions
          .toSorted((a, b) => b.revisions.at(-1)!.createdAt.localeCompare(a.revisions.at(-1)!.createdAt))
          .map((s) => ({ title: `[${s.project ?? "未分类"}] ${s.title}`, value: s.id,
            description: `${s.revisions.length} 版 · ${s.revisions.at(-1)!.createdAt} · ${s.revisions.at(-1)!.device}` })) });
        if (!selected) return;
        const entry = sessions.find((s) => s.id === selected)!;
        const action = await dialog.select({ title: entry.title, options: [
          { title: "下载最新版本", value: "latest" },
          { title: "浏览／下载历史版本", value: "history" },
          { title: "修改展示标题", value: "rename" },
          { title: "修改项目标签", value: "project" },
          { title: "删除单个历史版本", value: "revision" },
          { title: "删除整个备份条目", value: "delete" },
        ] });
        if (action === "latest") return download(view, entry, entry.revisions.at(-1));
        if (action === "history") return download(view, entry);
        if (action === "rename") {
          const title = await dialog.prompt({ title: "备份展示标题（不改写导出文件）", value: entry.title });
          if (title === undefined) return;
          if (!title.trim() || title.trim().length > 200) throw new SyncError("input", "标题需要 1–200 个字符。");
          await rpc.edit({ backupID: entry.id, title: title.trim(), project: entry.project, expectedToken: view.token }, options);
          success("已修改展示标题。");
        } else if (action === "project") {
          const project = await chooseProject(view, entry.project);
          if (!project) return;
          await rpc.edit({ backupID: entry.id, title: entry.title, project: project.value, expectedToken: view.token }, options);
          success("已修改项目标签。");
        } else if (action === "delete" || action === "revision") {
          const revisionID = action === "revision" ? await dialog.select({ title: "选择要删除的历史版本",
            options: [...entry.revisions].reverse().map((r) => ({ title: `${r.createdAt} · ${r.device}`, value: r.id,
              description: `${r.bytes} bytes · ${r.id}` })) }) : undefined;
          if (action === "revision" && !revisionID) return;
          if (!await dialog.confirm({ title: "永久删除远端备份？",
            message: `${entry.title}\n${revisionID ? `删除版本：${revisionID}` : `删除全部 ${entry.revisions.length} 个版本`}\n不删除本地 session；此操作无法撤销。` })) return;
          const result = await rpc.remove({ backupID: entry.id, revisionID, expectedToken: view.token }, options);
          if (result.failed.length) await dialog.alert({ title: "索引已更新，部分文件未删除", message: `${result.failed.length} 个文件删除失败，可稍后使用孤立文件清理。` });
          else success("已删除远端备份。");
        }
      }

      async function settingsMenu() {
        type Settings = Awaited<ReturnType<typeof rpc.settings>>;
        const save = async (view: Settings, projects: string[], workspaces: Settings["workspaces"]) => {
          await rpc.saveSettings({ projects, workspaces, expectedToken: view.token }, options);
          success("项目／工作区设置已保存，下次上传自动生效。远端历史未修改。");
        };
        const projectName = async (value?: string): Promise<string | undefined> => {
          const name = await dialog.prompt({ title: "项目标签", value, placeholder: "例如 my-app" });
          if (name === undefined) return;
          if (!name.trim() || name.trim().length > 200) throw new SyncError("input", "项目标签需要 1–200 个字符。");
          return name.trim();
        };
        const chooseLocalProject = async (view: Settings, initial?: string): Promise<string | undefined> => {
          const projects = [...new Set([...view.projects, ...view.workspaces.map((w) => w.project)])].sort();
          const choice = await dialog.select({ title: `选择默认项目（当前：${initial ?? "未设置"}）`, options: [
            ...projects.map((p, index) => ({ title: p, value: `project:${index}` })),
            { title: "新建项目标签…", value: "new" },
          ] });
          if (choice === undefined) return;
          return choice === "new" ? projectName() : projects[Number(choice.slice(8))];
        };
        const withProject = (view: Settings, project: string) => [...new Set([...view.projects, project])];
        const projectSettings = async (view: Settings) => {
          const action = await dialog.select({ title: "管理本机 projects", options: [
            { title: "新增项目标签", value: "add" },
            { title: "重命名项目标签", value: "rename", disabled: !view.projects.length },
            { title: "删除项目标签", value: "delete", disabled: !view.projects.length },
          ] });
          if (!action) return;
          if (action === "add") {
            const project = await projectName();
            if (!project) return;
            if (view.projects.includes(project)) throw new SyncError("input", "项目标签已存在。");
            await save(view, [...view.projects, project], view.workspaces);
            return;
          }
          const selected = await dialog.select({ title: "选择项目标签", options: view.projects.map((p) => ({ title: p, value: p })) });
          if (!selected) return;
          const count = view.workspaces.filter((w) => w.project === selected).length;
          if (action === "rename") {
            const project = await projectName(selected);
            if (!project || project === selected) return;
            if (view.projects.includes(project)) throw new SyncError("input", "项目标签已存在；不能通过重命名合并项目。");
            if (!await dialog.confirm({ title: "确认重命名本机项目", message: `${selected} → ${project}\n同时更新 ${count} 个工作区映射。远端备份标签保持不变。` })) return;
            await save(view, view.projects.map((p) => p === selected ? project : p),
              view.workspaces.map((w) => w.project === selected ? { ...w, project } : w));
          } else if (action === "delete") {
            if (!await dialog.confirm({ title: "删除本机项目标签？", message: `${selected}\n同时解除 ${count} 个工作区映射。不会删除本地 session，也不会修改远端备份。` })) return;
            await save(view, view.projects.filter((p) => p !== selected), view.workspaces.filter((w) => w.project !== selected));
          }
        };
        const currentWorkspace = async (view: Settings) => {
          const action = await dialog.select({ title: `当前工作区：${view.directory}`, options: [
            { title: "设置／修改默认项目", value: "set", description: view.defaultProject ?? "未设置" },
            { title: "解除当前工作区映射", value: "remove", disabled: view.currentWorkspaceIndex < 0 },
          ] });
          if (action === "set") {
            const project = await chooseLocalProject(view, view.defaultProject);
            if (!project) return;
            const workspaces = view.workspaces.filter((_, index) => index !== view.currentWorkspaceIndex);
            workspaces.push({ directory: view.directory, project });
            await save(view, withProject(view, project), workspaces);
          } else if (action === "remove" && view.currentWorkspaceIndex >= 0) {
            if (!await dialog.confirm({ title: "解除当前工作区映射？", message: `${view.directory}\n项目标签及所有备份保留，后续上传仍可逐次选择项目。` })) return;
            await save(view, view.projects, view.workspaces.filter((_, index) => index !== view.currentWorkspaceIndex));
          }
        };
        const workspaceSettings = async (view: Settings) => {
          const choice = await dialog.select({ title: "管理本机 workspaces", options: [
            { title: "添加工作区映射…", value: "add" },
            ...view.workspaces.map((w, index) => ({ title: `${w.project} · ${w.directory}`, value: `workspace:${index}` })),
          ] });
          if (!choice) return;
          const index = choice === "add" ? -1 : Number(choice.slice(10));
          const existing = view.workspaces[index];
          const action = existing ? await dialog.select({ title: existing.directory, options: [
            { title: "修改路径／项目", value: "edit" }, { title: "删除映射", value: "remove" },
          ] }) : "edit";
          if (action === "remove" && existing) {
            if (!await dialog.confirm({ title: "删除工作区映射？", message: `${existing.directory}\n项目标签和备份保持不变。` })) return;
            await save(view, view.projects, view.workspaces.filter((_, i) => i !== index));
          } else if (action === "edit") {
            const directory = await dialog.prompt({ title: "工作区绝对路径（服务端机器）", value: existing?.directory ?? view.directory });
            if (directory === undefined) return;
            const project = await chooseLocalProject(view, existing?.project);
            if (!project) return;
            const workspaces = view.workspaces.filter((_, i) => i !== index);
            workspaces.push({ directory: directory.trim(), project });
            await save(view, withProject(view, project), workspaces);
          }
        };
        while (!disposed) {
          // Local settings do not require network access, credentials or a remote index.
          const view = await rpc.settings({}, options);
          const action = await dialog.select({ title: "WebDAV 插件设置", options: [
            { title: "管理项目标签 projects", value: "projects", description: `${view.projects.length} 个项目` },
            { title: "当前工作区默认项目", value: "current-workspace", description: view.defaultProject ?? "未设置" },
            { title: "管理工作区映射 workspaces", value: "workspaces", description: `${view.workspaces.length} 个映射` },
            { title: "查看配置位置及说明", value: "info", description: view.configFile },
            { title: "返回", value: "back" },
          ] });
          if (!action || action === "back") return;
          if (action === "projects") await projectSettings(view);
          else if (action === "current-workspace") await currentWorkspace(view);
          else if (action === "workspaces") await workspaceSettings(view);
          else if (action === "info") await dialog.alert({ title: "配置", message: `${view.configFile}\n默认跟随 OpenCode 配置目录。修改保存后下次操作自动生效。\n`
            + "projects 和 workspaces 可在此菜单配置，即使 WebDAV 尚未配置或不可用。\n服务器连接与明文密码仍在文件中设置，不在 UI 中显示。请限制本机文件权限。\n"
            + "项目重命名／删除只影响本机配置及关联工作区，远端历史标签不变。" });
        }
      }

      try {
        const action = await dialog.select({ title: "WebDAV Session 备份", options: [
          { title: "上传当前 session", value: "upload", disabled: !sessionID },
          { title: "下载／管理远端备份与历史", value: "browse" },
          { title: "检查并清理孤立文件", value: "clean" },
          { title: "连接测试（只读）", value: "test" },
          { title: "设置 projects／workspaces", value: "settings" },
        ] });
        if (action === "upload") await upload();
        else if (action === "browse") await browse();
        else if (action === "test") {
          const result = await rpc.test({}, options);
          await dialog.alert({ title: "连接成功（未测试写权限）", message: `远端备份数：${result.sessions}\n${result.indexExists ? "索引有效。" : "备份目录或索引尚未初始化，首次上传时创建。"}` });
        } else if (action === "settings") await settingsMenu();
        else if (action === "clean") {
          const scan = await rpc.scan({}, options);
          if (!scan.paths.length) await dialog.alert({ title: "孤立文件检查", message: "未发现未被索引引用的插件历史文件。其他文件及空目录不会清理。" });
          else {
            await dialog.alert({ title: `孤立文件预览：${scan.paths.length} 个`, message: scan.paths.join("\n") });
            if (await dialog.confirm({ title: "永久清理这些孤立文件？", message: "文件可能来自未完成的上传或删除。请确保其他设备没有写入，确认后无法恢复。" })) {
              const result = await rpc.clean({ expectedToken: scan.token, scanToken: scan.scanToken }, options);
              await dialog.alert({ title: "清理结果", message: `已删除 ${result.deleted} 个；失败 ${result.failed.length} 个。` });
            }
          }
        }
      } catch (error) {
        const known = error instanceof SyncError ? error.message
          : error && typeof error === "object" && "type" in error && error.type === "operation_failed" && "message" in error && typeof error.message === "string" ? error.message
            : "操作失败或已取消。请检查 OpenCode 连接与插件版本。为保护凭据，不展示原始错误。";
        if (!disposed) await dialog.alert({ title: "WebDAV 操作未完成", message: known });
      } finally { running = false; controller = undefined; }
    }
    ctx.keymap.layer(() => ({ mode: "global", commands: [{
      id: "webdav-sync.menu", title: "WebDAV Session 备份", group: "WebDAV", palette: true,
      slash: { name: "webdav" }, run: open,
    }] }));
    return () => { disposed = true; controller?.abort(); };
  },
});
