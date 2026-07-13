# Memlume Codex Plugin

此 Plugin 讓 Codex 與同一台電腦上的 Memlume Shared Brain 協作。它不會取代 Codex 既有的設定、session transcript 或原生記憶；Memlume 只提供可掛載、可備份、可由多個 Agent 共用的外部記憶腦袋。

## 需要什麼

- 已在本機建置 Memlume Core（包含 `@memlume/adapter-sdk` 與 MCP Server）。
- 已建立 Codex 的 agent installation，並為目標 Project Brain 掛上 `read` 或 `read_write` 權限。
- Node.js 22 以上，以及已安裝並信任此 Codex Plugin 的 hooks。

安裝時請選擇此資料夾：`adapters/codex`。Codex 會要求你審閱並信任 Plugin hook；這是必要步驟，因為 hooks 會在每個回合讀取本機環境變數並呼叫 loopback 的 Memlume daemon。

## 設定

將下列值放在啟動 Codex 的環境。不要把 adapter token 寫進 `.mcp.json`、`hooks.json` 或 Git。

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

`MEMLUME_HOME` 必須指向完整 Memlume repository，Plugin 即使被安裝到另一個資料夾，也只會從這個位置載入已建置的 Core。MCP launcher 會確認實際載入的檔案仍在此目錄內。

## 每一回合怎麼運作

| Codex event | Memlume 行為 |
| --- | --- |
| `SessionStart` | 準備本機 Adapter envelope 與 runtime；不可用時靜默略過，不會在此階段驗證 daemon、身分或 mount，也不會寫入 Core。 |
| `UserPromptSubmit` | 先讀取 Project Brain 的 Shared Context，再以暫時 `additionalContext` 注入本回合；同時把明確記憶請求交給 Core。 |
| `Stop` | 記錄本回合最後的 assistant 輸出作為 task audit，永遠回傳 `{}`；它不是 session 結束事件。 |

例如使用者說「`記住專案使用 pnpm`」，Plugin 會以 Project scope 與指定 Brain 交給 Memlume Core。Core 決定是否保存、改為候選項目、忽略或拒絕，也會執行敏感資料防護及 mount 權限檢查。Codex 原有記憶與設定仍獨立存在。

Plugin 本身不會讀取或寫入 Codex transcript、原生記憶或設定檔；它只回傳官方 `UserPromptSubmit` hook 的 developer-context 輸出。Codex 要如何顯示或持久化這項輸出，會隨 Codex 版本而變動，因此不應將它視為 Plugin 對 transcript 持久化行為的保證；請以目前版本的 [Codex Hooks 文件](https://learn.chatgpt.com/docs/hooks#userpromptsubmit) 為準。Shared Context 會明確標記為背景參考，系統、developer 與當前使用者指示永遠優先。

若 daemon 暫時不可用，hook 仍會成功結束，不會阻斷 Codex。只有明確記憶請求能進入本機 outbox 等待下次 `UserPromptSubmit` 重送；`Stop` 的 audit 不會被離線宣稱為已保存，也不會假裝 session-end 重送。

## MCP 工具

Plugin 同時附帶 `memlume` MCP Server，讓 Codex 可使用 `memlume.resolve_context`、`memlume.record_event`、`memlume.remember` 與 `memlume.search`。MCP 與 hook 使用相同的 `MEMLUME_HOME`、`MEMLUME_DAEMON_URL`、`MEMLUME_TOKEN`，但各自只處理需要的工作：hook 負責回合生命週期，MCP 提供明確工具呼叫。

## 驗證

```powershell
pnpm run test:codex
```

測試會複製 Plugin 後執行實際 hook，確認 Context 注入、Project Brain capture、turn audit、離線 outbox 與 token 不外洩。
