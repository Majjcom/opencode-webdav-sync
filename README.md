# OpenCode WebDAV Session Sync

面向 **OpenCode V2 TUI** 的手动 session 备份插件。使用官方会话导出／导入 API，不读取或修改 OpenCode 数据库。

## 功能

- `/webdav` 菜单及命令面板入口，不调用大模型、不产生同步用的聊天消息。
- 只上传打开菜单时的当前 session；正在运行的会话需等待空闲。
- 下载最新或历史版本到当前工作区，**始终生成新的 session 和消息 ID**；选择立即切换或仅创建。原 session 不变。
- 下载的会话首次上传时，选择继续来源备份历史或另建备份条目。
- 单一 `index.json` 管理所有备份及历史版本；内容不变时不重复上传。
- 本地与远端发生分歧时，手动选择追加本地版本、下载远端为新会话、另建条目或取消，不自动合并。
- OpenCode／插件版本不同时警告并要求确认；索引或备份格式不兼容时阻止操作。
- 历史全部保留，支持按项目筛选、修改展示标题／项目、删除单版／整条备份。
- 孤立文件扫描、清理预览与再次确认；下载前验证文件大小及 SHA-256。
- HTTPS + Basic 认证，密码在独立配置文件中设置。
- UI 管理本机项目列表及工作区默认项目映射，不需要 WebDAV 在线。

## 安装与加载

需要 OpenCode **2.2.x**；真实 API 集成测试使用 **2.2.6 / Windows**。代码采用跨平台路径及标准 Web API，macOS／Linux 的实际客户端兼容性仍需验证。开发需要 Node.js 22+ 和 npm。

在本目录执行：

```sh
npm install
npm run build
```

在 OpenCode 的全局或项目 `opencode.json(c)` **现有 `plugins` 数组中追加**下列条目，保留其他配置。一个条目同时加载服务端和 TUI 部分：

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "D:/Code/Js/opencode-webdav-sync"
    }
  ]
}
```

macOS／Linux 使用对应的绝对路径。OpenCode 会自动重载配置，也可使用 `/reload`。随后输入 `/webdav` 或在命令面板选择 **WebDAV Session 备份**。

可运行 `npm pack` 生成安装包；此项目尚未发布到 npm，不要把示例包名当作已发布的依赖。插件 SDK 由 OpenCode 主程序提供，不随插件打包。

## 独立配置

将 [`webdav-sync.example.json`](./webdav-sync.example.json) 复制到以下位置，填写真实服务器信息：

默认目录直接跟随 OpenCode，可运行 `opencode debug paths config` 查看实际目录；插件文件名为 `webdav-sync.json`。

| 环境 | 默认位置 |
| --- | --- |
| Windows | `%USERPROFILE%\.config\opencode\webdav-sync.json` |
| macOS／Linux | `~/.config/opencode/webdav-sync.json` |
| 设置了 `XDG_CONFIG_HOME` | `$XDG_CONFIG_HOME/opencode/webdav-sync.json` |
| 设置了 `OPENCODE_CONFIG_DIR` | `$OPENCODE_CONFIG_DIR/webdav-sync.json`（优先于 XDG） |

也可以在加载条目的 `options.configPath` 中指定绝对路径，或设置服务端进程的 `OPENCODE_WEBDAV_CONFIG` 环境变量。优先级：`options.configPath` > 环境变量 > 默认位置。

```jsonc
{
  "plugins": [
    {
      "package": "D:/Code/Js/opencode-webdav-sync",
      "options": {
        "configPath": "C:/Users/your-user/private/webdav-sync.json"
      }
    }
  ]
}
```

**独立配置是严格 JSON**，不支持注释、尾逗号或 OpenCode 的 `{env:...}` 替换。每次操作重新读取，无需重新加载插件。若 TUI 连接远端 OpenCode，配置文件位于 **OpenCode 服务端所在机器**，导入目标也是该服务端上的当前工作区。

最小配置：

```json
{
  "url": "https://dav.example.com/webdav/",
  "username": "your-user",
  "password": "your-app-password",
  "root": "opencode-backups",
  "device": "my-laptop",
  "sanitize": false,
  "projects": ["my-app", "notes"],
  "workspaces": [
    { "directory": "D:/Code/my-app", "project": "my-app" }
  ]
}
```

| 字段 | 说明 |
| --- | --- |
| `url` | 已存在的 WebDAV 集合地址，只接受 HTTPS；不允许内嵌凭据、查询参数或 fragment |
| `username`, `password` | Basic 认证；建议使用应用专用密码，用户名不能含 `:` |
| `root` | 在 `url` 下创建的专用相对目录，默认 `opencode-backups`，支持多级，不允许 `..` |
| `device` | 备份设备名称，默认本机 hostname |
| `timeoutMs` | 单次请求及响应读取超时，默认 30000，范围 1000–300000 |
| `maxBackupBytes` | 单份备份大小上限，默认 67108864（64 MiB），最大 1 GiB；仍受 OpenCode RPC 请求限制约束 |
| `sanitize` | 默认 `false`；调用官方导出的同名选项 |
| `projects` | 用户定义的可选项目标签，不关联 OpenCode 项目 ID |
| `workspaces` | 本地工作区绝对路径与默认标签的精确映射，上传时可改选；不按父目录继承 |

同一个项目在不同设备上可以使用不同路径，只要映射到相同标签即可。历史菜单也能将已有备份重新分类。上传时临时输入的新标签会保存到该备份的索引，不自动改写配置文件；需要持久化时使用下面的设置菜单。

### 在 UI 设置 projects 和 workspaces

执行 `/webdav` → **设置 projects／workspaces**：

- **管理项目标签 projects**：新增、重命名、删除本机项目标签。
- **当前工作区默认项目**：选择／新建默认项目，或解除当前工作区映射，无需输入目录。
- **管理工作区映射 workspaces**：浏览、添加、编辑路径／项目、删除任意映射。目录必须是服务端机器上的绝对路径，不允许重复映射。
- **查看配置位置及说明**：显示服务端配置文件位置，不显示密码。

重命名项目会一并更新本机引用它的工作区映射；删除项目会在确认后解除相关映射。**这些设置不改动远端备份标签，也不删除任何 session 或备份**；已有远端条目的分类仍通过历史管理菜单单独调整。

设置保存到同一份 `webdav-sync.json`，立即对下一次操作生效；只更新 `projects` 和 `workspaces`，保留连接参数、密码及其他 JSON 配置值。写入使用同目录临时文件和原子替换，检测到手动编辑冲突时拒绝覆盖。Unix 新文件权限为 `600`；Windows 替换文件继承所在目录 ACL，请限制配置目录权限。

此菜单不访问 WebDAV。即使未配置连接也可以使用：文件不存在时创建仅含项目和工作区字段的配置文件，之后再手动补齐 `url`、`username`、`password` 等连接参数。无效 JSON 不会被自动覆盖。

### 密码与隐私

- 按需求，密码**明文存放于配置**。不要提交到版本库、放在共享目录或在对话中粘贴真实配置。
- macOS／Linux 建议 `chmod 600 ~/.config/opencode/webdav-sync.json`；Windows 使用文件 ACL 限制为当前用户可读。
- 插件不上传配置／密码，不记录认证头或原始网络错误；菜单不会显示密码。
- HTTPS 证书必须被服务端系统信任。自建 CA 应正常安装信任，不要关闭 TLS 校验。
- 备份没有客户端加密；WebDAV 管理员及有读权限的人能读取内容。SHA-256 是完整性检查，不是防篡改签名。
- **`sanitize: true` 会清除正文、工具输入输出、部分附件数据等，不能完整恢复对话。** 不应将它当作完整备份或全面脱敏保证。
- 项目标签、设备名称及来源 session ID 等索引元数据不受官方 `sanitize` 处理。

## 使用流程

### 上传

1. 打开目标 session，等待运行结束，执行 `/webdav` → 上传当前 session。
2. 若来自下载，首次上传选择继续来源历史或另建条目。
3. 出现版本差异或分歧时手动确认／选择，不会自动覆盖或合并。
4. 选择项目标签，确认隐私提示后执行官方导出及 WebDAV 上传。

普通本地 session 首次上传自动创建备份条目，后续沿用本地来源关联。来源关联按服务器隔离，由 OpenCode 插件存储持久化。删除本地插件存储后，插件不会仅凭标题猜测条目归属。

“以本地为准”表示**追加一个新历史版本**，不会删除远端历史；“以远端为准”下载为新 session，旧本地 session 保留。

### 下载

`/webdav` → 下载／管理 → 全部或按项目筛选 → 备份条目 → 最新／历史版本 → 创建并切换或仅创建。

只在校验通过后调用官方导入。官方导入本身会验证消息格式。为了在同一数据库中反复导入相同备份，新 session 和所有顶层消息获得独立 ID；消息正文、工具输入输出及原生回放内容不会做全局字符串替换。

导入副本不保留外部父 session／fork 关系、文件回滚状态、原工作区子路径、归档标记或保存的权限规则。备份文件本身保持原始官方导出内容，不受这些导入调整影响。导入历史不会重新执行历史工具。

**范围限制：**官方导出是已落定消息的 projected transcript，不是完整数据库快照。插件不递归导出其他 session，不备份工作区文件、配置、凭据、未完成执行、待处理队列、独立指令存储或外部文件。附件／媒体是否可恢复取决于官方导出实际包含的内容。换设备继续会话时，仍需自行配置模型、工具及工作区文件。

### 历史与维护

- 修改展示标题／项目仅修改 `index.json`，不改写导出文件。
- 删除操作先更新索引，再删除文件；单版和整条删除均需要确认，且不删除本地 session。
- 上传中断或物理删除失败可能留下孤立文件。维护菜单仅清理符合插件命名格式、且不被当前索引引用的文件。
- 清理前完整预览并确认，执行前重新核对索引和扫描结果。其他文件、空目录不会删除。
- 连接测试只读，不测试写权限；不存在的备份目录在首次上传时创建。

## 远端协议及恢复策略

服务器需支持 `GET`、`PUT`、`MKCOL`、`DELETE`、`PROPFIND`（Depth 1）。`url` 本身应已存在，插件只创建 `root` 及其子目录。推荐独立备份目录并启用 WebDAV 服务自身的文件历史／快照，尤其是 `index.json`。

```text
opencode-backups/
├── index.json
└── sessions/
    └── b_<随机 ID>/
        ├── r_<随机 ID>.json
        └── r_<随机 ID>.json
```

索引格式版本为 `1`：统一管理备份标题、项目、版本链、来源基础版本、上传时间、设备、大小、摘要、OpenCode／插件版本及脱敏设置。条目 ID 与 OpenCode session ID 分离，项目仅是标签。

- 上传先写不可变的新版本文件，再提交索引；不会用新内容覆盖历史文件。
- 索引修改前重新读取核对；有强 ETag 时额外使用条件写入。没有 ETag 的服务仍可用于单写者操作。
- **只支持同一时间一个设备／进程写入。** 进程内有操作互斥，但没有跨进程／跨设备锁，也不保证并发写入或服务器写入中断时的原子性。ETag 检查不能取代这个限制。
- 索引大小上限 16 MiB，单次目录 XML 上限 8 MiB。
- 索引损坏／格式不兼容时停止操作，不自动重建；索引缺失但存在历史目录时拒绝上传和清理。请从 WebDAV 快照手动恢复索引后继续。
- 若首次上传的索引写入失败，可能只有历史文件、没有索引；不会自动丢弃这些文件。应由用户检查并恢复索引／自行保留文件后处理。
- 写入超时不自动重试：服务器可能已经完成提交。请刷新查看实际状态后再操作。
- 官方导入若响应中断，服务器也可能已创建副本；请先检查会话列表，避免重复导入。原会话不会被覆盖。

## 开发与测试

```sh
npm run typecheck
npm test
npm run build
```

测试覆盖核心存储、WebDAV 协议／安全边界、故障恢复及模拟 TUI 操作。运行时直接依赖是 `zod` 和 `fast-xml-parser`；OpenCode SDK 是开发依赖及可选 peer。当前 SDK 2.2.6 的传递开发依赖仍有 npm audit 中等风险提示，未进行可能破坏 SDK 兼容性的强制升级。

可选真实 API 集成测试：

```sh
npm run test:native
```

它创建独立目录、配置、数据库、缓存及服务进程，不调用模型、不使用真实 WebDAV、不修改现有会话；验证真实插件／RPC 加载、与 OpenCode 自身一致的配置目录、项目和工作区设置持久化及密码保留、官方导出、重复导入新 ID、脱敏和原会话不变。测试数据保留在输出的临时路径，进程在测试结束时停止。

如果找不到 OpenCode 可执行文件：

```sh
node --import tsx scripts/native-smoke.ts --binary /absolute/path/to/opencode
```

Windows 需要指向真实 `opencode.exe`，而不是 PowerShell 包装脚本。可用 `--plugin /path/to/unpacked/package` 验证已安装的发行包。`test:native` 不替代在真实终端和你的自建 WebDAV 上的最终验收；本项目不会自行配置或连接你的真实服务器。

## 代码结构

```text
src/index.ts      服务端插件、RPC 注册、错误脱敏
src/tui.ts        菜单、用户确认、官方会话导出／导入
src/rpc.ts        类型化 RPC 契约
src/config.ts     独立配置与项目映射
src/model.ts      索引／备份校验、摘要及新导入 ID
src/service.ts    版本管理、冲突、索引提交与维护
src/webdav.ts     HTTPS Basic WebDAV 传输
tests/           自动化测试
scripts/         隔离原生 API 集成测试
```
