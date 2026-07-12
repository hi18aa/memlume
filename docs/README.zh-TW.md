<p align="center">
  <img src="../assets/logo/memlume-logo.svg" width="380" alt="Memlume 標誌：相連的記憶節點與發光核心">
</p>

# Memlume

[English](../README.md) | [繁體中文](README.zh-TW.md) | [简体中文](README.zh-CN.md)

Memlume 是供 AI Agent 與開發工具使用的本機結構化記憶服務。它記錄不可變事件、儲存具 scope 的記憶、以 SQLite FTS5 搜尋，並為特定工作解析出可追溯的 Context Pack。

## 狀態與範圍

此儲存庫是 `0.1.0` 原始碼 workspace。目前所有套件均為 private；請以 clone 並建置此儲存庫的方式使用，不能從公開套件 registry 安裝。

已實作：

- Append-only Event Journal 與本機 SQLite 資料庫。
- 結構化的 `policy`、`preference`、`fact`、`decision` 記憶。
- global、domain、agent、workspace、project、task scope。
- SQLite FTS5 搜尋，以及含來源記憶 ID 與 context budget 的確定性 Context Resolver。
- 僅限 localhost 的 daemon、CLI，以及皆經由 daemon 呼叫的 MCP stdio server。

v0.1.0 尚未實作：

- Outcome tracking、conflict handling、Memory Compiler、網頁 Console、vector／embedding search、遠端同步、雲端託管、多使用者存取。
- 公開 npm 套件或任何已發布的 release artifact。
- 經由 daemon、CLI、MCP Server 建立 `procedure` 或 `capability` 記憶；可寫入 API 僅接受上述四種記憶類型。

## 需求

- Node.js `>=22`
- pnpm `10.30.3`
- 可寫入本機 SQLite 資料庫的檔案系統位置

## 安裝與建置

請將 `<repository-url>` 替換成此儲存庫的 Git URL。

```sh
git clone <repository-url> memlume
cd memlume
pnpm install --frozen-lockfile
pnpm build
```

## 啟動 daemon

daemon 僅會監聽 `127.0.0.1`。先建立預設資料目錄：

```sh
mkdir -p data
```

```powershell
New-Item -ItemType Directory -Force data | Out-Null
```

再於另一個終端機持續執行下列命令：

```sh
pnpm --filter @memlume/daemon start -- --database ./data/memlume.sqlite --port 3849
```

`--database` 預設值為 `data/memlume.sqlite`，`--port` 預設值為 `3849`。以 `Ctrl+C` 停止程序。

請在另一個終端機檢查健康狀態：

```sh
curl http://127.0.0.1:3849/v1/health
# {"status":"ok"}
```

## CLI

編譯後的 CLI 位於 `apps/cli/dist/index.js`。預設 URL 為 `http://127.0.0.1:3849`；若 daemon 使用其他 port，請在 command 前指定 `--url`。`--url`、`--json` 等 global option 必須置於 command 前。

```sh
# 記錄不可變事件。
node apps/cli/dist/index.js --json event add "Brand colors approved." --type note --reference readme-demo

# 儲存 Policy。Policy 必須有 --intent、--action-type、--action-target。
node apps/cli/dist/index.js --json remember "Use the image generator for image requests." \
  --kind policy --scope project --project readme-demo \
  --intent generate_image --action-type route_tool --action-target image_gen --required

# 搜尋已儲存的記憶。
node apps/cli/dist/index.js --json search "image generator"

# 依 intent 與 scope 解析 Context Pack。
node apps/cli/dist/index.js --json context resolve \
  --intent generate_image --scope project --project readme-demo --budget 500
```

`remember` 會按記憶類型驗證欄位。例如 preference 需要 `--preference-domain`、`--subject`、`--dimension`、`--value`、`--strength`、`--confidence`；fact 需要 `--subject`、`--predicate`、`--object`、`--confidence`；decision 需要 `--title`、`--status`、`--rationale`。

### 最小端到端範例

daemon 在 port `3849` 執行時，請依序執行：

```sh
node apps/cli/dist/index.js --json event add "Brand colors approved." --type note --reference readme-demo

node apps/cli/dist/index.js --json remember "Use the image generator for image requests." \
  --kind policy --scope project --project readme-demo \
  --intent generate_image --action-type route_tool --action-target image_gen --required

node apps/cli/dist/index.js --json context resolve \
  --intent generate_image --scope project --project readme-demo --budget 500
```

最後的 JSON 會在 `context.directives` 包含儲存的 Policy，並有 `actionTarget: "image_gen"`。腳本使用時請加上 `--json`，它會輸出原始 daemon response。

## MCP stdio Server

先建置、維持 daemon 執行，再將下列內容加入 MCP Client 的 stdio 設定。請把 `/absolute/path/to/memlume` 換成此 checkout 的絕對路徑；Windows 的 `args` 請填入 Windows 絕對路徑。

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

`MEMLUME_DAEMON_URL` 僅接受 loopback 的 `http://127.0.0.1` 或 `http://[::1]` origin。Server 提供四個 daemon-backed tool：

- `memlume.record_event`
- `memlume.remember`
- `memlume.search`
- `memlume.resolve_context`

例如 MCP Client 可用下列參數呼叫 `memlume.resolve_context`：

```json
{
  "intent": "generate_image",
  "scope": { "level": "project", "projectId": "readme-demo" },
  "task": "Create an image for the project README.",
  "contextBudget": 500,
  "available_tools": ["image_gen"]
}
```

MCP 使用 `available_tools`（snake case）；daemon 會收到 `availableTools`。

## 隱私與本機運作

Memlume 將資料儲存在 `--database` 指定的 SQLite 檔案，預設為 `data/memlume.sqlite`。v0.1.0 沒有遠端同步或雲端服務，daemon 也只綁定 loopback。這可避免網路曝露，但無法阻止可讀取該資料庫路徑的其他本機程序。系統尚未實作 authentication 或 at-rest encryption；請以作業系統權限保護資料庫，且不要存放不適合置於本機明文 SQLite 檔案的秘密資料。

## 架構

```text
CLI ───────────┐
               ├─> localhost daemon (127.0.0.1) ─> SQLite + FTS5
MCP stdio ─────┘               │
                               ├─> append-only event journal
                               ├─> structured memory store
                               └─> context resolver
```

CLI 與 MCP Server 不會自行開啟 SQLite，而是對 daemon 發送 request。Context Resolver 會在適用時回傳 directives、preferences、facts、decisions、來源記憶 ID、排除項目與 context-budget 資訊。

## 測試

```sh
pnpm typecheck
pnpm test
pnpm build
```

## 貢獻

請保持變更精簡；非平凡行為請新增或更新最接近的 Vitest coverage，並在開啟 pull request 前執行上述命令。請勿把遠端儲存、vector search 或 Console 當作 v0.1.0 的附帶變更加入。

## 授權

Memlume 採用 [MIT License](../LICENSE) 授權。
