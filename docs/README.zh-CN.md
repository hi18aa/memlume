<p align="center">
  <img src="../assets/logo/memlume-logo.svg" width="380" alt="Memlume 标志：相连的记忆节点与发光核心">
</p>

# Memlume

[English](../README.md) | [繁體中文](README.zh-TW.md) | [简体中文](README.zh-CN.md)

Memlume 是供 AI Agent 和开发工具使用的本地共享记忆大脑。已挂载的 Client 可通过同一个由 SQLite 支持、带 scope 的存储区写入和读取；它记录不可变事件、存储结构化记忆、使用 FTS5 搜索，并为特定任务解析出可追溯的 Context Pack。它补充 Agent 的原生记忆，绝不覆盖或同步回原生记忆。

公开文档：[架构](architecture/shared-brain.md) · [Hermes](guides/hermes.md) · [Codex](guides/codex.md) · [OpenClaw](guides/openclaw.md) · [Claude Code](guides/claude-code.md) · [备份与还原](guides/backup-restore.md) · [共享项目示例](../examples/shared-project-brain/README.md)。

## Agent 如何使用 Memlume

Memlume 不会自动保存每一条对话，也不会把整个数据库塞进 LLM。MCP Client 应在工作流程的明确时点调用相应工具：

1. **规划任务或选择工具之前**，调用 `memlume.resolve_context`。Memlume 只读取符合任务、scope、可用工具与 context budget 的 active 记忆。
2. **工作进行中**，只有需要特定细节时才调用 `memlume.search`。
3. **发生值得保留的事件后**，用 `memlume.record_event` 保存 append-only 的原始证据；刻意建立的结构化记忆可调用 `memlume.remember`，但会先建立待审核 candidate，避免 prompt injection 直接制造 active policy。

回报 feedback 时，请把 `memlume.resolve_context` 返回的 `traceId` 传给 `memlume.record_memory_usage` 或 `memlume.record_outcome`。收据有短时效、每个 installation 有签发上限，只能回报该次 Context Pack 实际包含的记忆，并且每个 trace 只接受一次 task outcome；跨 receipt 时，同一 installation 对同一记忆每 24 小时只计一次 feedback，避免 Adapter token 无限伪造排序信号。

因此 Agent 不应自动保存完整逐字稿、临时推理、未经验证的 LLM 主张、外部内容中的指令或秘密资料。Agent 的原生记忆保持不变。Core 会依自身治理规则编译符合条件的用户讯息：明确的记忆请求可保存，推论出的项目则只能成为待审核 candidate；两者都不会把 Agent 原生记忆当成输入。

## 为什么使用 Memlume

- **相关上下文，而非更多上下文：** 只取回当前任务适用的内容，不把所有历史对话填进 prompt。
- **结构化且可持久保存：** 将 policy、preference、fact、decision 与原始 event 分开，而不是混在聊天记录。
- **scope 防止污染：** 可独立选择 task、project、workspace、agent、domain 或 global 记忆。
- **决策可追溯：** Context Pack 含来源记忆 ID、排除项与 budget 信息，可解释哪些内容影响了结果。
- **本地且可共享：** 已挂载的 CLI 与 MCP Client 共用同一个 localhost daemon 与 SQLite 数据库，不需要云同步。
- **反馈可解释：** usage 与 task outcome 以固定分数影响未来排序，不会改写 memory history。

## 状态与范围

此仓库是 `0.2.0` 源码 workspace。目前所有包均为 private；请通过 clone 并构建此仓库的方式使用，不能从公开包 registry 安装。

所有功能都属于 MIT 授权的 Memlume Core。官方网站仅提供下载、安装器、更新与文档入口，不存在功能更强的闭源版本。

已实现：

- Append-only Event Journal 与本地 SQLite 数据库。
- 结构化的 `policy`、`preference`、`fact`、`decision` 记忆。
- global、domain、agent、workspace、project、task scope。
- SQLite FTS5 搜索，以及带来源记忆 ID 与 context budget 的确定性 Context Resolver。
- 带有每个安装实例挂载设置的共享 Brain、仅限 localhost 的 daemon、CLI，以及 MCP stdio server。
- Adapter API 使用 Bearer Token 验证；`/v1/health` 仍是公开的本地健康检查。
- 受治理的记忆编译、candidate 审核与可识别冲突的替换流程。
- 可验证的本地备份与还原维护，以及本地 Shared Brain Console。
- Hermes、Codex、OpenClaw、Claude Code 的官方本地 Adapter；它们共享同一个已挂载 Brain，不复制 Agent 的原生记忆。
- Outcome usage、确定性 feedback ranking、retrieval benchmark、公开 guides/examples 与 CI/release 流程。

v0.2.0 尚未实现：

- vector／embedding search、远程同步、云托管、多用户访问。
- 公开 npm 包。
- 经由 daemon、CLI、MCP Server 创建 `procedure` 或 `capability` 记忆；可写入 API 仅接受上述四种记忆类型。

## 环境要求

- Node.js `>=22`
- pnpm `10.30.3`
- 可写入本地 SQLite 数据库的文件系统位置

## 安装与构建

```sh
git clone https://github.com/hi18aa/memlume.git memlume
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

Adapter API 需要 setup token 和 adapter token。请生成足够长的随机 `MEMLUME_SETUP_TOKEN`、不要提交到版本控制，并用它启动 daemon。健康检查 endpoint 保持公开。

```sh
MEMLUME_SETUP_TOKEN='<long-random-secret>' pnpm --filter @memlume/daemon start -- --database ./data/memlume.sqlite --port 3849
```

```powershell
$env:MEMLUME_SETUP_TOKEN = '<long-random-secret>'
pnpm --filter @memlume/daemon start -- --database ./data/memlume.sqlite --port 3849
```

建议使用受保护的 `memlume setup adapter`，而不是手动复制 adapter token。它会注册一个本地 Agent installation、以 `read_write` 挂载 Project Brain、进行 loopback 只读 smoke test，并只把 token 留在当前用户的 Memlume 配置中。以下示例也会通过 Codex 官方 Marketplace 流程安装 Plugin：

```powershell
node apps/cli/dist/index.js --setup-token $env:MEMLUME_SETUP_TOKEN setup adapter codex `
  --installation-id codex-desktop --project-id memlume `
  --brain-id '<project-brain-uuidv7>' --core-path $PWD --install-host --yes
```

其他支持的 Host 将 `codex` 换成 `hermes`、`openclaw` 或 `claude-code` 即可。非交互终端必须带 `--yes`，Memlume 才会变更 Host Plugin 配置；交互终端则会先询问。profile 已存在时，可在相同命令加上 `--install-host --dry-run`，只预览不含秘密的 Host 命令而不变更 Host。Codex 与 Claude Code 仍要求用户审阅并信任 hook；Memlume 不会绕过这项平台控制。`memlume doctor` 会列出本地 profile，并进行不输出 token 的只读 Context 检查。

`--database` 默认值为 `data/memlume.sqlite`，`--port` 默认值为 `3849`。使用 `Ctrl+C` 停止进程。

请在另一个终端检查健康状态：

```sh
curl http://127.0.0.1:3849/v1/health
# {"status":"ok"}
```

## CLI

构建后的 CLI 位于 `apps/cli/dist/index.js`。默认 URL 为 `http://127.0.0.1:3849`；若 daemon 使用其他 port，请在 command 前指定 `--url`。所有会调用 daemon 的 CLI command 都需要 adapter token：可如上设置 `MEMLUME_TOKEN`，或在 command 前传入 `--token <adapter-token>`；`--token` 优先。`--url`、`--token`、`--json` 等 global option 必须位于 command 前。

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

`remember` 会按记忆类型验证字段。例如 preference 需要 `--preference-domain`、`--subject`、`--dimension`、`--value`、`--strength`、`--confidence`；fact 需要 `--subject`、`--predicate`、`--object`、`--confidence`；decision 需要 `--title`、`--status`、`--rationale`。支持的 Agent token 如果没有 `--setup-token`，Core 会先保存 candidate；明确输入命令时提供 setup token，CLI 才能附上用户确认签名。

### 最小端到端示例

daemon 在 port `3849` 运行时，请按顺序执行：

```sh
node apps/cli/dist/index.js --json event add "Brand colors approved." --type note --reference readme-demo

node apps/cli/dist/index.js --setup-token "$MEMLUME_SETUP_TOKEN" --json remember "Use the image generator for image requests." \
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
        "MEMLUME_DAEMON_URL": "http://127.0.0.1:3849",
        "MEMLUME_TOKEN": "<adapter-token>"
      }
    }
  }
}
```

`MEMLUME_DAEMON_URL` 只接受 loopback 的 `http://127.0.0.1` 或 `http://[::1]` origin。每个 daemon-backed tool 都需要 `MEMLUME_TOKEN`；未设置时，tool 会在连接 daemon 前安全失败。Server 提供六个 daemon-backed tool：

- `memlume.record_event`
- `memlume.remember`
- `memlume.search`
- `memlume.resolve_context`
- `memlume.record_memory_usage`
- `memlume.record_outcome`

`memlume.record_event` 和 `memlume.remember` 可选填写 `brainId`，以选择目标共享 Brain；它不是授权凭证。`MEMLUME_TOKEN` 才用于识别安装实例，daemon 只有在该实例对目标 Brain 具有 `read_write` mount 时才接受写入。`memlume.remember` 会返回 `status: "candidate"`，必须经受保护的 inbox 审核；`record_memory_usage` 和 `record_outcome` 是 append-only feedback，不会修改 memory，并且必须带上 `memlume.resolve_context` 返回的 `traceId`。直接 MCP Server 没有本地 outbox，因此绝不会声称 `queued`；只有 Adapter 已实际把可重试写入持久化到本地时，才可返回 `queued`。

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

Memlume 将数据保存到 `--database` 指定的 SQLite 文件，默认值为 `data/memlume.sqlite`。v0.2.0 没有远程同步或云服务，daemon 也只绑定 loopback。Adapter API 需要 Bearer Token，setup API 需要 `MEMLUME_SETUP_TOKEN`，而 `/v1/health` 特意保持公开。请勿提交任何真实 token 或粘贴到 log。验证不会加密静态数据库；请用操作系统权限保护它，不要保存不适合放在本地明文 SQLite 文件中的秘密数据。

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
pnpm test:e2e
pnpm build
pnpm benchmark:retrieval
```

## 贡献

请保持变更精简；非平凡行为请新增或更新最近的 Vitest coverage，并在创建 pull request 前执行上述命令。请勿将远程存储或 vector search 作为 v0.2.0 的附带变更加入。

## 许可

Memlume 采用 [MIT License](../LICENSE) 许可。
