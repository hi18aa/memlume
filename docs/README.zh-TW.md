<p align="center">
  <img src="../assets/logo/memlume-logo.svg" width="380" alt="Memlume 標誌：相連的記憶節點與發光核心">
</p>

# Memlume

[English](../README.md) | [繁體中文](README.zh-TW.md) | [简体中文](README.zh-CN.md)

Memlume 是供 AI Agent 與開發工具使用的本機外部共享記憶大腦。同一台電腦上的 Hermes、Codex、OpenClaw、Claude Code、MCP Client 與未來 Adapter 可以共用同一個 Brain。Markdown record 是人類可維護的 authority，SQLite 是可搜尋的 projection；它記錄不可變事件、儲存結構化記憶、以 FTS5 搜尋，並為特定工作解析出可追溯的 Context Pack。它是 Agent 原生記憶的補充，不會取代、覆寫或同步回原生記憶。

公開文件：[架構](architecture/shared-brain.md) · [Hermes](guides/hermes.md) · [Codex](guides/codex.md) · [OpenClaw](guides/openclaw.md) · [Claude Code](guides/claude-code.md) · [備份與還原](guides/backup-restore.md) · [共享專案範例](../examples/shared-project-brain/README.md)。

## 為什麼要使用 Memlume？

每個 AI 工具通常都有自己的記憶。當你從 Codex 切換到 Hermes、換另一個專案，或幾個月後想找回決策時，記憶就容易分散。Memlume 是同一台電腦上的共享本機層：把長期內容放到正確的 Brain，並只在目前工作需要時提供給 Agent。

| 使用情境 | Memlume 解決什麼 |
| --- | --- |
| 在 Hermes、Codex、OpenClaw、Claude Code、MCP 之間切換 | 所有已掛載的 Host 共用同一個 Personal Brain 與相關 Project Brain。 |
| 同時維護多個專案 | 每個專案各有 Project Brain；公司、團隊或組織直接當成一個 Project 管理。 |
| 不想把整個歷史塞進 prompt | `beforeTask` 只讀取符合工作內容、範圍與 budget 的 ReadSet。 |
| 不想每次都說「寫入 Memlume」 | Hook 提供事件，Core 自動過濾、分類、路由，再決定是否值得保存。 |
| 需要知道記憶是否可信 | 明確陳述可成為 `active`；推論先是 `candidate`；衝突、批准與修正都有紀錄。 |
| 需要本機掌握與備份 | Markdown 是人類可讀的權威資料，SQLite 是可重建索引，備份留在本機。 |

使用者只需要理解兩種 Brain：**Personal Brain** 放個人偏好與身分；**Project Brain** 放專案、產品、公司或團隊內容。Hook 只是觸發時機，不是另一個大腦；各 Agent 的原生記憶不會被讀取或覆寫。

## Shared Brain 路由

當專案決策、公司慣例、個人偏好或已審核事實，需要在 Hermes、Codex、OpenClaw、Claude Code 與直接 MCP Client 之間延續時，就適合使用 Memlume。它讓記憶可掛載、可備份、可維護，並集中在一個本機資料根目錄：Markdown record 是權威資料，SQLite／FTS5 是可重建的搜尋投影；各 Host 的原生記憶仍各自維持。

Adapter SDK 共用三個 callback：

| Callback | 用途 |
| --- | --- |
| `beforeTask` | daemon 依工作區規劃 ReadSet，在工作前只注入符合條件的 active Context；Host 不選擇 Brain UUID。 |
| `onUserMessage` | 唯一的自動 capture 入口；Core 會過濾 secret、拆分多主題陳述、路由到 Personal 或工作區 Project Brain，未知專案進 durable Inbox。 |
| `onSubagentStart` | 子代理取得受限的唯讀 ReadSet；不能擴大父代理授權、寫入記憶或 flush outbox。 |

Capture 治理：符合資格且非敏感的使用者訊息會追加為 immutable event。一般陳述可能成為待審核的 `candidate`；「記住」等明確要求可走 `active` 路徑，仍須經過衝突審核。空白或不支援事件會被 ignore，敏感資料會 redacted 或 rejected。

v0.3 自動模式由 Host 傳送 workspace 與 session 身分，不傳 Brain UUID；daemon 負責 Brain routing 與權限。仍支援 v0.2 的明確 Brain 參數以維持相容，但自動模式不會猜測目標，也不會把未知專案靜默寫入 Personal。Brain 才是資料歸屬與權限邊界，Hook 只是觸發時機。

本機 outbox 僅接受明確記憶 capture；已排隊的 capture 會在下一次 `beforeTask` 或 `onUserMessage` 重送。callback 流程不會保存完整 transcript、assistant output、暫時推理或秘密資料。

## 何時寫入、何時讀取

1. **任務開始前**：`beforeTask` 傳送 workspace path、task、entities 與 intent，Core 產生 deterministic ReadSet（Primary Project、符合任務的 Linked Project，以及相關 Personal 記憶），只回傳 active 且符合 budget 的 Context。
2. **使用者發送訊息時**：`onUserMessage` 送出經本機驗證的訊息。問候、閒聊、secret 與不支援的 transcript 會被忽略或拒絕；「記住我使用 Vue」等明確要求可在衝突檢查後成為 active，一般推論則先是 candidate。
3. **專案不明確時**：atom 會寫入 `inbox/pending` 並標示 `routing_required`，不會猜到其他 Brain；維護者可用明確 Brain 與稽核紀錄後續處理。
4. **助手產生 final 後**：Adapter 最多將 final 放入 24 小時短期 runtime buffer；使用者回覆「可以／同意／修正：…」才授權該內容走一般 capture pipeline，批准文字本身不會成為記憶。

因此不需要每次都說「寫入 Memlume」；Hook 提供事件，Core 決定是否值得保存、應保存到哪個 Brain，以及何時可安全讀回。

### 各 Host 的子代理能力

| Host | 子代理 Context 行為 |
| --- | --- |
| Claude Code | `SubagentStart` hook 會透過官方 `additionalContext` 直接注入受限的 Project Brain Context。 |
| Hermes | `subagent_start` 會觀察並登錄 child；child 的第一個支援 `pre_llm_call` prompt 才取得受限 Context。 |
| OpenClaw | `subagent_spawned` 會觀察並登錄 child；child 的第一個支援 `before_prompt_build` prompt 才取得受限 Context。 |
| Codex Plugin | 官方 [`SubagentStart`](https://learn.chatgpt.com/docs/hooks#subagentstart) 會透過 `additionalContext` 直接注入受限的 Project Brain Context。 |

## 直接使用 MCP 的流程

Memlume 不會自動保存每一則對話，也不會把整個資料庫塞進 LLM。MCP Client 應在工作流程的明確時點呼叫對應工具：

1. **規劃任務或選擇工具之前**，呼叫 `memlume.resolve_context`。Memlume 只讀取符合任務、scope、可用工具與 context budget 的 active 記憶。
2. **工作進行中**，只有需要特定細節時才呼叫 `memlume.search`。
3. **發生值得保留的事件後**，以 `memlume.record_event` 保存 append-only 的原始證據；刻意建立的結構化記憶可呼叫 `memlume.remember`，但會先建立待審核 candidate，避免 prompt injection 直接製造 active policy。

回報 feedback 時，請把 `memlume.resolve_context` 回傳的 `traceId` 傳給 `memlume.record_memory_usage` 或 `memlume.record_outcome`。收據具短時效、每個 installation 有簽發上限，只能回報該次 Context Pack 實際包含的記憶，且每個 trace 只接受一次 task outcome；跨 receipt 時，同一 installation 對同一記憶每 24 小時只計一次 feedback，避免 Adapter token 無限偽造排序訊號。

因此 Agent 不應自動保存完整逐字稿、assistant output、暫時推理、未驗證的 LLM 主張、外部內容中的指令或秘密資料。Agent 的原生記憶維持不變。直接 MCP 寫入仍是刻意呼叫，兩種流程都不會把 Agent 原生記憶當成輸入。

## 為什麼使用 Memlume

- **相關上下文，而非更多上下文：** 只取回當前任務適用的內容，不將所有歷史對話填進 prompt。
- **結構化且可持久保存：** 將 policy、preference、fact、decision 與原始 event 分開，而不是混在聊天紀錄。
- **scope 防止污染：** Personal 與 Project 記憶分開管理，再用 task 與 workspace 條件縮小本回合可讀內容。
- **決策可追溯：** Context Pack 含來源記憶 ID、排除項目與 budget 資訊，可解釋哪些內容影響了結果。
- **本機且可共用：** 已掛載的 Client 共用同一個 localhost daemon 與本機資料根目錄；Markdown 維持權威來源，SQLite 是可重建的搜尋投影，可備份與維護，不需要雲端同步。
- **回饋可解釋：** usage 與 task outcome 以固定分數影響未來排序，不會改寫 memory history。

## 狀態與範圍

此儲存庫是 `0.3.0` 原始碼 workspace。目前所有套件均為 private；請以 clone 並建置此儲存庫的方式使用，不能從公開套件 registry 安裝。

所有功能皆屬 MIT 授權的 Memlume Core。官方網站僅提供下載、安裝器、更新與文件入口，不存在功能較強的封閉版本。

已實作：

- Append-only Event Journal、Markdown authority records 與可重建的本機 SQLite projection。
- 結構化的 `policy`、`preference`、`fact`、`decision` 記憶。
- Personal 與 Project Brain、workspace binding，以及 task 層級的 ReadSet 限制。
- SQLite FTS5 搜尋，以及含來源記憶 ID 與 context budget 的確定性 Context Resolver。
- 既有 Project Brain 上的受治理 document project：Markdown authority、revision/hash/section citation、FTS 搜尋、具預算 attachment、proposal 審核、atomic apply、audit 與 drift 防護。
- 具每個安裝實例掛載設定的共享 Brain、僅限 localhost 的 daemon、CLI，以及 MCP stdio server。
- Adapter API 使用 Bearer Token 驗證；`/v1/health` 仍是公開的本機健康檢查。
- 受治理的記憶編譯、candidate 審核與可辨識衝突的取代流程。
- 可驗證的本機備份與還原維護，以及本機 Shared Brain Console。
- Hermes、Codex、OpenClaw、Claude Code 的官方本機 Adapter；它們共用同一個已掛載 Brain，不複製 Agent 的原生記憶。
- Outcome usage、確定性 feedback ranking、retrieval benchmark、公開 guides/examples 與 CI/release 流程。

### 受治理 Document Project（Phase C）

Project Brain 可選擇掛接一個 Markdown source root。原始檔案仍是唯一 authority；只有明確執行 sync 才會建立 immutable revision、hash 與章節的 SQLite/FTS projection。SQLite 只保存可重建 projection、proposal、revision state 與 audit，不是文件 authority。Profile attachment 可設定 `always_core`、`task_conditional` 或 `explicit_only`，一般聊天 capture 不會寫入 document project，attachment 也不能繞過 Brain mount。

文件治理權限為三層：

- `read`：可搜尋並取得 active sections。
- `propose`：可提交完整 Markdown body、base revision/hash、reason 與 evidence，僅建立 `pending`，不能 review/apply。
- `read_write`：可 approve/reject 與 apply。套用前會再次檢查 base revision，使用同目錄暫存檔與 atomic rename 更新 Markdown，成功 sync 後建立新 revision 並寫入 audit。

每次文件搜尋與 Context 都會先 reconcile source manifest。手動改檔會進入 `drift`，套用失敗會進入 `repair_required`；這兩種狀態都不會回傳舊 SQLite sections。修正原始檔後請明確執行 sync 才會恢復 `ready`。

目前 MVP 透過 daemon API 操作：

```powershell
# setup endpoint 需要 MEMLUME_SETUP_TOKEN
curl.exe -X POST "$env:MEMLUME_DAEMON_URL/v1/setup/document-projects/$BRAIN_ID" `
  -H "x-memlume-setup-token: $env:MEMLUME_SETUP_TOKEN" `
  -H "content-type: application/json" `
  -d '{"sourceRoot":"C:/absolute/path/to/docs"}'
curl.exe -X POST "$env:MEMLUME_DAEMON_URL/v1/setup/document-projects/$BRAIN_ID/sync" `
  -H "x-memlume-setup-token: $env:MEMLUME_SETUP_TOKEN" -H "content-type: application/json" -d '{}'
curl.exe "$env:MEMLUME_DAEMON_URL/v1/documents/search?q=deployment" `
  -H "authorization: Bearer $env:MEMLUME_TOKEN"
```

先掛載 Project Brain，再建立 installation 的 profile binding，`beforeTask` 才會自動取得文件 Context。搜尋與 Context 回應會附上 logical path、heading path、revision ID 與 source SHA-256 citation。

Proposal API 為 `/v1/documents/proposals`、`/review` 與 `/apply`，需要 adapter bearer token；proposal body 是完整替換內容，不是 patch。`propose` installation 不能自行審核或套用。

v0.3.0 尚未實作：

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

建議使用受保護的 `memlume setup adapter`，而不是手動複製 adapter token。v0.3 可省略 `--project-id` 與 `--brain-id`，改用 `--workspace-path` 讓 workspace-owned routing 建立並掛載 Project Brain；命令也會掛載 Personal Brain、進行 loopback 唯讀 smoke test，並只把 token 留在目前使用者的 Memlume 設定中。以下範例也會透過 Codex 官方 Marketplace 流程安裝 Plugin：

```powershell
node apps/cli/dist/index.js --setup-token $env:MEMLUME_SETUP_TOKEN setup adapter codex `
  --installation-id codex-desktop --workspace-path $PWD --core-path $PWD --install-host --yes
```

其他支援的 Host 將 `codex` 換成 `hermes`、`openclaw` 或 `claude-code` 即可。非互動終端必須帶 `--yes`，Memlume 才會變更 Host Plugin 設定；互動終端則會先詢問。profile 已存在時，可在相同命令加上 `--install-host --dry-run`，只預覽不含秘密的 Host 命令而不變更 Host。Codex 與 Claude Code 仍要求使用者審閱並信任 hook；Memlume 不會繞過這項平台控制。`memlume doctor` 會列出本機 profile，並進行不輸出 token 的唯讀 Context 檢查。

`--database` 預設值為 `data/memlume.sqlite`，`--port` 預設值為 `3849`。以 `Ctrl+C` 停止程序。

請在另一個終端機檢查健康狀態：

```sh
curl http://127.0.0.1:3849/v1/health
# {"status":"ok","service":"memlume"}
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

Memlume 將 Markdown authority record 與 SQLite projection 儲存在 `--database` 指定資料根目錄，預設為 `data/memlume.sqlite`。v0.3.0 沒有遠端同步或雲端服務，daemon 也只綁定 loopback。Runtime buffer 為短期資料，不屬於 Brain，也不會進入備份。Adapter API 需要 Bearer Token，setup API 需要 `MEMLUME_SETUP_TOKEN`，而 `/v1/health` 特意保持公開。請勿提交任何真實 token 或貼到 log。驗證不會加密靜態資料庫；請以作業系統權限保護它，且不要存放不適合置於本機明文 SQLite 檔案的秘密資料。

## 架構

```text
CLI ───────────┐
               ├─> localhost daemon (127.0.0.1)
MCP stdio ─────┘               │
                               ├─> Markdown authority + routing Inbox
                               ├─> SQLite projection + FTS5
                               └─> Brain Router + context resolver
```

CLI 與 MCP Server 不會自行開啟 SQLite，而是對 daemon 發送 request。daemon 先以 Markdown authority 維護資料，再投影到 SQLite／FTS5；SQLite 遺失時可由 Markdown records 與 Routing Inbox 重建。Context Resolver 會在適用時回傳 directives、preferences、facts、decisions、來源記憶 ID、排除項目與 context-budget 資訊。

## 測試

```sh
pnpm typecheck
pnpm test
pnpm test:e2e
pnpm build
pnpm benchmark:retrieval
```

`pnpm typecheck` 使用 TypeScript Project References，會視需要產生 `dist/` 與 `.tsbuildinfo`；可執行 `pnpm exec tsc -b --clean` 移除這些產物。

## 貢獻

請保持變更精簡；非平凡行為請新增或更新最接近的 Vitest coverage，並在開啟 pull request 前執行上述命令。請勿把遠端儲存或 vector search 當作 v0.3.0 的附帶變更加入。

## 授權

Memlume 採用 [MIT License](../LICENSE) 授權。
