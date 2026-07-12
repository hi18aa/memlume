<p align="center">
  <img src="../assets/logo/memlume-logo.svg" width="380" alt="Memlume 标志：相连的记忆节点与发光核心">
</p>

# Memlume

[English](../README.md) | [繁體中文](README.zh-TW.md) | [简体中文](README.zh-CN.md)

Memlume 是供 AI Agent 和开发工具使用的本地结构化记忆服务。它记录不可变事件、存储带 scope 的记忆、使用 SQLite FTS5 搜索，并为特定任务解析出可追溯的 Context Pack。

## 状态与范围

此仓库是 `0.1.0` 源码 workspace。目前所有包均为 private；请通过 clone 并构建此仓库的方式使用，不能从公开包 registry 安装。

已实现：

- Append-only Event Journal 与本地 SQLite 数据库。
- 结构化的 `policy`、`preference`、`fact`、`decision` 记忆。
- global、domain、agent、workspace、project、task scope。
- SQLite FTS5 搜索，以及带来源记忆 ID 与 context budget 的确定性 Context Resolver。
- 仅限 localhost 的 daemon、CLI，以及都经由 daemon 调用的 MCP stdio server。

v0.1.0 尚未实现：

- Outcome tracking、conflict handling、Memory Compiler、网页 Console、vector／embedding search、远程同步、云托管、多用户访问。
- 公开 npm 包或任何已发布的 release artifact。
- 经由 daemon、CLI、MCP Server 创建 `procedure` 或 `capability` 记忆；可写入 API 仅接受上述四种记忆类型。

## 环境要求

- Node.js `>=22`
- pnpm `10.30.3`
- 可写入本地 SQLite 数据库的文件系统位置

## 安装与构建

请将 `<repository-url>` 替换为此仓库的 Git URL。

```sh
git clone <repository-url> memlume
cd memlume
pnpm install --frozen-lockfile
pnpm build
```

## 启动 daemon

daemon 只会监听 `127.0.0.1`。先创建默认数据目录：

```sh
mkdir -p data
```

```powershell
New-Item -ItemType Directory -Force data | Out-Null
```

再在另一个终端持续运行以下命令：

```sh
pnpm --filter @memlume/daemon start -- --database ./data/memlume.sqlite --port 3849
```

`--database` 默认值为 `data/memlume.sqlite`，`--port` 默认值为 `3849`。使用 `Ctrl+C` 停止进程。

请在另一个终端检查健康状态：

```sh
curl http://127.0.0.1:3849/v1/health
# {"status":"ok"}
```

## CLI

构建后的 CLI 位于 `apps/cli/dist/index.js`。默认 URL 为 `http://127.0.0.1:3849`；若 daemon 使用其他 port，请在 command 前指定 `--url`。`--url`、`--json` 等 global option 必须位于 command 前。

```sh
# 记录不可变事件。
node apps/cli/dist/index.js --json event add "Brand colors approved." --type note --reference readme-demo

# 保存 Policy。Policy 必须提供 --intent、--action-type、--action-target。
node apps/cli/dist/index.js --json remember "Use the image generator for image requests." \
  --kind policy --scope project --project readme-demo \
  --intent generate_image --action-type route_tool --action-target image_gen --required

# 搜索已保存的记忆。
node apps/cli/dist/index.js --json search "image generator"

# 按 intent 与 scope 解析 Context Pack。
node apps/cli/dist/index.js --json context resolve \
  --intent generate_image --scope project --project readme-demo --budget 500
```

`remember` 会按记忆类型验证字段。例如 preference 需要 `--preference-domain`、`--subject`、`--dimension`、`--value`、`--strength`、`--confidence`；fact 需要 `--subject`、`--predicate`、`--object`、`--confidence`；decision 需要 `--title`、`--status`、`--rationale`。

### 最小端到端示例

daemon 在 port `3849` 运行时，请按顺序执行：

```sh
node apps/cli/dist/index.js --json event add "Brand colors approved." --type note --reference readme-demo

node apps/cli/dist/index.js --json remember "Use the image generator for image requests." \
  --kind policy --scope project --project readme-demo \
  --intent generate_image --action-type route_tool --action-target image_gen --required

node apps/cli/dist/index.js --json context resolve \
  --intent generate_image --scope project --project readme-demo --budget 500
```

最终 JSON 会在 `context.directives` 包含保存的 Policy，并有 `actionTarget: "image_gen"`。脚本使用时请加上 `--json`，它会输出原始 daemon response。

## MCP stdio Server

先构建、保持 daemon 运行，再将下列内容加入 MCP Client 的 stdio 配置。请将 `/absolute/path/to/memlume` 替换为此 checkout 的绝对路径；Windows 的 `args` 请填写 Windows 绝对路径。

```json
{
  "mcpServers": {
    "memlume": {
      "command": "node",
      "args": ["/absolute/path/to/memlume/apps/mcp-server/dist/index.js"],
      "env": {
        "MEMLUME_DAEMON_URL": "http://127.0.0.1:3849"
      }
    }
  }
}
```

`MEMLUME_DAEMON_URL` 只接受 loopback 的 `http://127.0.0.1` 或 `http://[::1]` origin。Server 提供四个 daemon-backed tool：

- `memlume.record_event`
- `memlume.remember`
- `memlume.search`
- `memlume.resolve_context`

例如 MCP Client 可以使用以下参数调用 `memlume.resolve_context`：

```json
{
  "intent": "generate_image",
  "scope": { "level": "project", "projectId": "readme-demo" },
  "task": "Create an image for the project README.",
  "contextBudget": 500,
  "available_tools": ["image_gen"]
}
```

MCP 使用 `available_tools`（snake case）；daemon 会收到 `availableTools`。

## 隐私与本地运行

Memlume 将数据保存到 `--database` 指定的 SQLite 文件，默认值为 `data/memlume.sqlite`。v0.1.0 没有远程同步或云服务，daemon 也只绑定 loopback。这能避免网络暴露，但无法阻止可以读取该数据库路径的其他本地进程。系统尚未实现 authentication 或 at-rest encryption；请用操作系统权限保护数据库，不要保存不适合放在本地明文 SQLite 文件中的秘密数据。

## 架构

```text
CLI ───────────┐
               ├─> localhost daemon (127.0.0.1) ─> SQLite + FTS5
MCP stdio ─────┘               │
                               ├─> append-only event journal
                               ├─> structured memory store
                               └─> context resolver
```

CLI 和 MCP Server 不会自行打开 SQLite，而是向 daemon 发送 request。Context Resolver 会在适用时返回 directives、preferences、facts、decisions、来源记忆 ID、排除项与 context-budget 信息。

## 测试

```sh
pnpm typecheck
pnpm test
pnpm build
```

## 贡献

请保持变更精简；非平凡行为请新增或更新最近的 Vitest coverage，并在创建 pull request 前执行上述命令。请勿将远程存储、vector search 或 Console 作为 v0.1.0 的附带变更加入。

## 许可

目前尚未选定或提交 `LICENSE` 文件。在项目维护者选定并发布许可之前，请勿把此源码视为 open source 或重新分发。
