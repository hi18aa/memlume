# 變更紀錄

## 未發布 - 2026-07-17

### 新增

- Document Project read-only MVP：以既有 Project Brain 掛載 Markdown source root，顯式同步版本、章節與 FTS5 projection。
- profile document attachment 支援 `always_core`、`task_conditional`、`explicit_only`，並與既有 memory 共用 bounded context budget。
- `/v1/setup/document-projects/*`、`/v1/setup/installations/*/document-bindings`、`/v1/documents/search` 與 `/v1/documents/context` API。
- ContextPack 與 Hermes、Codex、OpenClaw、Claude Code renderer 顯示可回溯的文件 path、heading、revision 與 source hash citation。

### 邊界

- 文件 source root 為 Markdown authority；本階段只讀同步，不提供文件寫回、proposal、review 或自動 capture。

## [0.3.0] - 2026-07-16

### 新增

- 以 Markdown authority record 保存不可變語意版本，SQLite 僅作 projection 與 FTS5 搜尋。
- Personal／Project Brain 與 workspace Primary／Linked binding；Host 不再需要自行選擇 Brain UUID。
- `beforeTask`、`onUserMessage`、`onSubagentStart` 三個共用 callback 的自動路由流程。
- secret filter、atomization、Brain Router、`routing_required` durable Inbox、ReadSet Planner 與 callback heartbeat。
- bounded assistant-final runtime buffer，以及「可以／同意／修正」批准流程。
- Markdown-first v3 backup bundle、checksum 驗證與 daemon setup API。
- Hermes、Codex、OpenClaw、Claude Code、MCP 的 workspace-aware adapter transport。

### 相容性

- v0.2 的明確 `projectId`／`brainId` adapter profile 仍可使用；新安裝建議省略它們並提供 `workspacePath`。
- SQLite schema 會以 migration 升級；舊資料先 bootstrap 為 Personal，不會猜測 Project。
- Runtime buffer、adapter token、outbox 與 Host 狀態不屬於 Brain，也不會進入 Markdown v3 備份。

### 尚未包含

- 向量／embedding 搜尋、遠端同步、雲端服務與多使用者權限。
- 公開 npm registry 套件。
