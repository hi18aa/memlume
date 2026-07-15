# Memlume Codex Plugin

此 Plugin 讓 Codex 與同一台電腦上的 Memlume Shared Brain 協作。它不會取代 Codex 既有的設定、session transcript 或原生記憶；Memlume 只提供可掛載、可備份、可由多個 Agent 共用的外部記憶腦袋。

## 需要什麼

- 已在本機建置 Memlume Core（包含 `@memlume/adapter-sdk` 與 MCP Server）。
- 已建立 Codex 的 agent installation，並為目標 Project Brain 掛上 `read` 或 `read_write` 權限。
- Node.js 22 以上，以及已安裝並信任此 Codex Plugin 的 hooks。

安裝時請選擇此資料夾：`adapters/codex`。Codex 會要求你審閱並信任 Plugin hook；這是必要步驟，因為 hooks 會在每個回合讀取本機環境變數並呼叫 loopback 的 Memlume daemon。

## 設定

建議先執行 `memlume setup adapter codex`。Codex Plugin 與內建 MCP launcher 會從使用者帳號的 Memlume profile 讀取個別 installation 的 token，不會將它寫進 `.mcp.json`、`hooks.json` 或 Git。

下列環境變數可覆寫 profile，適合暫時測試或 CI：

```powershell
$env:MEMLUME_HOME = 'C:/work/memlume'
$env:MEMLUME_DAEMON_URL = 'http://127.0.0.1:3849'
$env:MEMLUME_TOKEN = 'your-adapter-token'
$env:MEMLUME_INSTALLATION_ID = 'your-installation-id'
$env:MEMLUME_PROFILE_ID = 'default'
$env:MEMLUME_PROJECT_ID = 'your-project-id'
$env:MEMLUME_BRAIN_ID = 'your-project-brain-uuidv7'
```

可選的 `MEMLUME_OUTBOX_DIRECTORY` 可指定明確記憶寫入失敗時的本機重送位置。未設定時，Plugin 使用 Codex 提供的 `PLUGIN_DATA`；該位置不可用才會回到 Memlume 預設資料夾。

`MEMLUME_HOME` 必須指向完整 Memlume repository；profile 的 `corePath` 也有相同要求。Plugin 即使被安裝到另一個資料夾，也只會從這個位置載入已建置的 Core。MCP launcher 會確認實際載入的檔案仍在此目錄內。

## 每一回合怎麼運作

| Codex event | Memlume 行為 |
| --- | --- |
| `SessionStart` | 準備本機 Adapter envelope 與 runtime；不可用時靜默略過，不會在此階段驗證 daemon、身分或 mount，也不會寫入 Core。 |
| `UserPromptSubmit` | 以 `beforeTask` 讀取已掛載的 **Project → Domain（Company）→ Personal** Context，再以暫時 `additionalContext` 注入本回合；同時以 `onUserMessage` 將使用者訊息交給 Core。 |

非敏感使用者訊息會以 Project scope 與指定 Brain 送到 Memlume Core，並追加 immutable event。依治理規則，非明確陳述可成為待審核 `candidate`；例如使用者說「`記住專案使用 pnpm`」時，明確要求可走 `active` 路徑，仍可能需衝突審核。空白或不支援事件可被 ignore，秘密資料會 redacted 或 rejected。Core 也會執行 mount 權限檢查。Codex 原有記憶與設定仍獨立存在。

Plugin 本身不會讀取或寫入 Codex transcript、原生記憶或設定檔；它只回傳官方 `UserPromptSubmit` hook 的 developer-context 輸出。Codex 要如何顯示或持久化這項輸出，會隨 Codex 版本而變動，因此不應將它視為 Plugin 對 transcript 持久化行為的保證；請以目前版本的 [Codex Hooks 文件](https://learn.chatgpt.com/docs/hooks#userpromptsubmit) 為準。Shared Context 會明確標記為背景參考，系統、developer 與當前使用者指示永遠優先。

若 daemon 暫時不可用，hook 仍會成功結束，不會阻斷 Codex。本機 outbox 僅接受明確記憶 capture，並在下一次 `UserPromptSubmit`（`beforeTask`／`onUserMessage`）重送；完整 transcript、assistant output 與暫時推理不會被保存。

## 子代理限制

Codex Plugin 目前沒有可用的 child-start Hook。因此它不會自動為子代理注入 Shared Context，也不會偽造事件、解析 transcript 或猜測 session ID。SDK 已提供受限的 `onSubagentStart` 入口，等待未來官方可注入 child Context 的 lifecycle event，或供外部 orchestration 明確呼叫；主 Agent 的正常 `beforeTask` 流程不受影響。

## MCP 工具

Plugin 同時附帶 `memlume` MCP Server，讓 Codex 可使用 `memlume.resolve_context`、`memlume.record_event`、`memlume.remember` 與 `memlume.search`。MCP 與 hook 使用相同的 `MEMLUME_HOME`、`MEMLUME_DAEMON_URL`、`MEMLUME_TOKEN`，但各自只處理需要的工作：hook 負責回合生命週期，MCP 提供明確工具呼叫。

## 驗證

```powershell
pnpm run test:codex
```

測試會複製 Plugin 後執行實際 hook，確認主 Agent Context 注入、Project Brain capture、離線 outbox、沒有多餘 assistant 寫入，以及 token 不外洩。
