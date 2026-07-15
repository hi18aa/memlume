<p align="center">
  <img src="../assets/logo/memlume-logo.svg" width="380" alt="Memlume 標誌：相連的記憶節點與發光核心">
</p>

# Memlume

[English](../README.md) | [繁體中文](README.zh-TW.md) | [简体中文](README.zh-CN.md)

Memlume 是供 AI Agent 與開發工具使用的本機外部共享記憶大腦。同一台電腦上的已掛載 Client 共用既有的 SQLite 儲存區；它記錄不可變事件、儲存結構化記憶、以 FTS5 搜尋，並為特定工作解析出可追溯的 Context Pack。它是 Agent 原生記憶的補充，不會取代、覆寫或同步回原生記憶。

公開文件：[架構](architecture/shared-brain.md) · [Hermes](guides/hermes.md) · [Codex](guides/codex.md) · [OpenClaw](guides/openclaw.md) · [Claude Code](guides/claude-code.md) · [備份與還原](guides/backup-restore.md) · [共享專案範例](../examples/shared-project-brain/README.md)。

## Shared Brain 路由

當專案決策、公司慣例、個人偏好或已審核事實，需要在 Hermes、Codex、OpenClaw、Claude Code 與直接 MCP Client 之間延續時，就適合使用 Memlume。它讓記憶可掛載、可備份、可維護，並集中在一個本機 SQLite 資料庫；各 Host 的原生記憶仍各自維持。

Adapter SDK 共用三個 callback：

| Callback | 用途 |
| --- | --- |
| `beforeTask` | 主 Agent 在工作前讀取已掛載 Context。預設優先序為 **Project → Domain（Company）→ Personal**；呼叫端只能要求更小的已授權範圍。 |
| `onUserMessage` | 唯一的自動 capture 入口。非敏感使用者訊息會送到 Core 並追加為 immutable event；依治理規則，非明確陳述可成為待審核的 `candidate`，而「記住」等明確要求可走 `active` 路徑，仍可能需衝突審核。空白或不支援事件可被 ignore，秘密資料會 redacted 或 rejected。 |
| `onSubagentStart` | 子代理只讀取其設定的 Project Brain Context；不會回退到 Domain 或 Personal、不會寫入，也不會 flush outbox。 |

主 Agent 的寫入目標依序是：明確指定的 Brain、profile 的 Project Brain、拒絕。Memlume 不會猜測目標，也絕不回退到 Personal。Brain 才是資料歸屬與權限邊界，Hook 只是觸發時機。

本機 outbox 僅接受明確記憶 capture；已排隊的 capture 會在下一次 `beforeTask` 或 `onUserMessage` 重送。callback 流程不會保存完整 transcript、assistant output、暫時推理或秘密資料。

### 各 Host 的子代理能力

| Host | 子代理 Context 行為 |
| --- | --- |
| Claude Code | `SubagentStart` hook 會直接注入受限的 Project Brain Context。 |
| Hermes | `subagent_start` 只登錄 child；child 的第一次 prompt 才取得受限 Context。 |
| OpenClaw | `subagent_spawned` 只登錄 child；child 的第一次 prompt 才取得受限 Context。 |
| Codex Plugin | 目前沒有可用的 child-start Hook，因此不會自動注入 child Context。SDK 已準備好未來官方 Hook 或外部 orchestration 使用的入口。 |

## 直接使用 MCP 的流程

Memlume 不會自動保存每一則對話，也不會把整個資料庫塞進 LLM。MCP Client 應在工作流程的明確時點呼叫對應工具：

1. **規劃任務或選擇工具之前**，呼叫 `memlume.resolve_context`。Memlume 只讀取符合任務、scope、可用工具與 context budget 的 active 記憶。
2. **工作進行中**，只有需要特定細節時才呼叫 `memlume.search`。
3. **發生值得保留的事件後**，以 `memlume.record_event` 保存 append-only 的原始證據；刻意建立的結構化記憶可呼叫 `memlume.remember`，但會先建立待審核 candidate，避免 prompt injection 直接製造 active policy。

回報 feedback 時，請把 `memlume.resolve_context` 回傳的 `traceId` 傳給 `memlume.record_memory_usage` 或 `memlume.record_outcome`。收據具短時效、每個 installation 有簽發上限，只能回報該次 Context Pack 實際包含的記憶，且每個 trace 只接受一次 task outcome；跨 receipt 時，同一 installation 對同一記憶每 24 小時只計一次 feedback，避免 Adapter token 無限偽造排序訊號。

因此 Agent 不應自動保存完整逐字稿、assistant output、暫時推理、未驗證的 LLM 主張、外部內容中的指令或秘密資料。Agent 的原生記憶維持不變。對 Adapter capture 而言，Core 會把非敏感使用者訊息追加為 immutable event；依治理規則，非明確陳述可成為待審核的 `candidate`，明確記憶要求可走 `active` 路徑並仍可能經過衝突審核。空白或不支援事件可被 ignore，秘密資料會 redacted 或 rejected。直接 MCP 寫入仍是刻意呼叫，兩種流程都不會把 Agent 原生記憶當成輸入。

## 為什麼使用 Memlume

- **相關上下文，而非更多上下文：** 只取回當前任務適用的內容，不將所有歷史對話填進 prompt。
- **結構化且可持久保存：** 將 policy、preference、fact、decision 與原始 event 分開，而不是混在聊天紀錄。
- **scope 防止污染：** 可獨立選取 task、project、workspace、agent、domain 或 global 記憶。
- **決策可追溯：** Context Pack 含來源記憶 ID、排除項目與 budget 資訊，可解釋哪些內容影響了結果。
- **本機且可共用：** 已掛載的 Client 共用同一個 localhost daemon 與 SQLite 資料庫，可備份與維護，不需要雲端同步。
- **回饋可解釋：** usage 與 task outcome 以固定分數影響未來排序，不會改寫 memory history。

## 狀態與範圍

此儲存庫是 `0.2.0` 原始碼 workspace。目前所有套件均為 private；請以 clone 並建置此儲存庫的方式使用，不能從公開套件 registry 安裝。

所有功能皆屬 MIT 授權的 Memlume Core。官方網站僅提供下載、安裝器、更新與文件入口，不存在功能較強的封閉版本。

已實作：

- Append-only Event Journal 與本機 SQLite 資料庫。
- 結構化的 `policy`、`preference`、`fact`、`decision` 記憶。
- global、domain、agent、workspace、project、task scope。
- SQLite FTS5 搜尋，以及含來源記憶 ID 與 context budget 的確定性 Context Resolver。
- 具每個安裝實例掛載設定的共享 Brain、僅限 localhost 的 daemon、CLI，以及 MCP stdio server。
- Adapter API 使用 Bearer Token 驗證；`/v1/health` 仍是公開的本機健康檢查。
- 受治理的記憶編譯、candidate 審核與可辨識衝突的取代流程。
- 可驗證的本機備份與還原維護，以及本機 Shared Brain Console。
- Hermes、Codex、OpenClaw、Claude Code 的官方本機 Adapter；它們共用同一個已掛載 Brain，不複製 Agent 的原生記憶。
- Outcome usage、確定性 feedback ranking、retrieval benchmark、公開 guides/examples 與 CI/release 流程。

v0.2.0 尚未實作：

- vector／embedding search、遠端同步、雲端託管、多使用者存取。
- 公開 npm 套件。
- 經由 daemon、CLI、MCP Server 建立 `procedure` 或 `capability` 記憶；可寫入 API 僅接受上述四種記憶類型。

## 需求

- Node.js `>=22`
- pnpm `10.30.3`
- 可寫入本機 SQLite 資料庫的檔案系統位置

## 安裝與建置

```sh
git clone https://github.com/hi18aa/memlume.git memlume
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

Adapter API 需要 setup token 與 adapter token。請產生長度足夠的隨機 `MEMLUME_SETUP_TOKEN`、不要提交至版本控制，並以它啟動 daemon。健康檢查 endpoint 維持公開。

```sh
MEMLUME_SETUP_TOKEN='<long-random-secret>' pnpm --filter @memlume/daemon start -- --database ./data/memlume.sqlite --port 3849
```

```powershell
$env:MEMLUME_SETUP_TOKEN = '<long-random-secret>'
pnpm --filter @memlume/daemon start -- --database ./data/memlume.sqlite --port 3849
```

建議使用受保護的 `memlume setup adapter`，而不是手動複製 adapter token。它會註冊一個本機 Agent installation、以 `read_write` 掛載 Project Brain、進行 loopback 唯讀 smoke test，並只把 token 留在目前使用者的 Memlume 設定中。以下範例也會透過 Codex 官方 Marketplace 流程安裝 Plugin：

```powershell
node apps/cli/dist/index.js --setup-token $env:MEMLUME_SETUP_TOKEN setup adapter codex `
  --installation-id codex-desktop --project-id memlume `
  --brain-id '<project-brain-uuidv7>' --core-path $PWD --install-host --yes
```

其他支援的 Host 將 `codex` 換成 `hermes`、`openclaw` 或 `claude-code` 即可。非互動終端必須帶 `--yes`，Memlume 才會變更 Host Plugin 設定；互動終端則會先詢問。profile 已存在時，可在相同命令加上 `--install-host --dry-run`，只預覽不含秘密的 Host 命令而不變更 Host。Codex 與 Claude Code 仍要求使用者審閱並信任 hook；Memlume 不會繞過這項平台控制。`memlume doctor` 會列出本機 profile，並進行不輸出 token 的唯讀 Context 檢查。

`--database` 預設值為 `data/memlume.sqlite`，`--port` 預設值為 `3849`。以 `Ctrl+C` 停止程序。

請在另一個終端機檢查健康狀態：

```sh
curl http://127.0.0.1:3849/v1/health
# {"status":"ok"}
```

## CLI

編譯後的 CLI 位於 `apps/cli/dist/index.js`。預設 URL 為 `http://127.0.0.1:3849`；若 daemon 使用其他 port，請在 command 前指定 `--url`。所有會呼叫 daemon 的 CLI command 都需要 adapter token：可如上設定 `MEMLUME_TOKEN`，或在 command 前傳入 `--token <adapter-token>`；`--token` 優先。`--url`、`--token`、`--json` 等 global option 必須置於 command 前。

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

`remember` 會按記憶類型驗證欄位。例如 preference 需要 `--preference-domain`、`--subject`、`--dimension`、`--value`、`--strength`、`--confidence`；fact 需要 `--subject`、`--predicate`、`--object`、`--confidence`；decision 需要 `--title`、`--status`、`--rationale`。支援的 Agent token 若沒有 `--setup-token`，Core 會先保存 candidate；明確輸入命令時提供 setup token，CLI 才能附上使用者確認簽章。

### 最小端到端範例

daemon 在 port `3849` 執行時，請依序執行：

```sh
node apps/cli/dist/index.js --json event add "Brand colors approved." --type note --reference readme-demo

node apps/cli/dist/index.js --setup-token "$MEMLUME_SETUP_TOKEN" --json remember "Use the image generator for image requests." \
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
        "MEMLUME_DAEMON_URL": "http://127.0.0.1:3849",
        "MEMLUME_TOKEN": "<adapter-token>"
      }
    }
  }
}
```

`MEMLUME_DAEMON_URL` 僅接受 loopback 的 `http://127.0.0.1` 或 `http://[::1]` origin。每個 daemon-backed tool 都需要 `MEMLUME_TOKEN`；未設定時，tool 會在連線 daemon 前安全失敗。Server 提供六個 daemon-backed tool：

- `memlume.record_event`
- `memlume.remember`
- `memlume.search`
- `memlume.resolve_context`
- `memlume.record_memory_usage`
- `memlume.record_outcome`

`memlume.record_event` 與 `memlume.remember` 可選填 `brainId`，以選擇目的共享 Brain；它不是授權憑證。`MEMLUME_TOKEN` 才用來識別安裝實例，daemon 只有在該實例對目標 Brain 具 `read_write` mount 時才接受寫入。`memlume.remember` 會回傳 `status: "candidate"`，必須經受保護的 inbox 審核；`record_memory_usage` 與 `record_outcome` 是 append-only feedback，不會修改 memory，且必須帶入 `memlume.resolve_context` 回傳的 `traceId`。直接 MCP Server 沒有本機 outbox，因此絕不宣稱 `queued`；只有 Adapter 已實際把可重試寫入持久化到本機時，才可回傳 `queued`。

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

Memlume 將資料儲存在 `--database` 指定的 SQLite 檔案，預設為 `data/memlume.sqlite`。v0.2.0 沒有遠端同步或雲端服務，daemon 也只綁定 loopback。Adapter API 需要 Bearer Token，setup API 需要 `MEMLUME_SETUP_TOKEN`，而 `/v1/health` 特意保持公開。請勿提交任何真實 token 或貼到 log。驗證不會加密靜態資料庫；請以作業系統權限保護它，且不要存放不適合置於本機明文 SQLite 檔案的秘密資料。

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
pnpm test:e2e
pnpm build
pnpm benchmark:retrieval
```

## 貢獻

請保持變更精簡；非平凡行為請新增或更新最接近的 Vitest coverage，並在開啟 pull request 前執行上述命令。請勿把遠端儲存或 vector search 當作 v0.2.0 的附帶變更加入。

## 授權

Memlume 採用 [MIT License](../LICENSE) 授權。
