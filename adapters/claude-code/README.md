# Memlume Claude Code Plugin

此 Plugin 讓 Claude Code 讀寫同一台電腦上的 Memlume Shared Brain。它不會讀取、修改或取代 Claude 的 `CLAUDE.md`、原生設定、session transcript 或其他原生記憶；Memlume 是獨立、可掛載、可備份、可由其他 Agent 共用的外部記憶層。

## 本機測試與安裝

先建置 Memlume Core。開發時可用 Claude Code 的 `--plugin-dir` 載入本資料夾，而不需要先建立 Marketplace：

```powershell
pnpm --filter @memlume/adapter-sdk build
pnpm --filter @memlume/mcp-server build
claude --plugin-dir ./adapters/claude-code
```

Claude Code 會在啟用 Plugin 時詢問設定值。`Memlume adapter token` 使用 Plugin 的 `userConfig.sensitive`，會放到 Claude Code 的安全儲存空間，不會寫入 `plugin.json`、`.mcp.json`、Git 或 Plugin 日誌。請填入已註冊的 Claude Code installation，以及對目標 Project Brain 有 `read` 或 `read_write` mount 的 `brain_id`。

`memlume_home` 必須是完整的 Memlume repository；Plugin 會確認實際載入的 Adapter SDK 與 MCP Server 都仍位於該目錄內。`daemon_url` 預設為 `http://127.0.0.1:3849`，且 Core 只接受 loopback 位址。

## 每一回合怎麼運作

| Claude Code hook | Memlume 行為 |
| --- | --- |
| `UserPromptSubmit` | 先讀取 Project Brain 的 bounded Shared Context，使用官方 `additionalContext` 暫時提供給當前回合；同時在獨立本機工作中送出使用者訊息。 |
| `Stop` | 在獨立本機工作中，把最後 assistant 文字寫成 task audit；不改變 Stop 的控制決策。 |
| `SessionEnd` | 在獨立本機工作中呼叫 `onSessionEnd`，重送先前已安全寫入本機 outbox 的明確記憶請求。 |

例如使用者說「`記住專案使用 pnpm`」，Plugin 會以設定的 Project scope 與 Brain 交給 Memlume Core。是否保存、成為候選、被忽略或被拒絕，以及敏感資料過濾、衝突治理與 mount 權限，都只能由 Core 決定。

Shared Context 明確標記為背景參考；系統、developer 與當前使用者指示永遠優先。Plugin 不會以 Shared Context 覆蓋 Claude 原生記憶，也不會把 Claude 原生記憶複製進 Memlume。

當 daemon 暫時無法使用時，context 讀取會 fail-open，Claude Code 會照常工作。明確記憶請求若無法送達，Adapter SDK 才會在 `${CLAUDE_PLUGIN_DATA}` 建立本機 outbox 並如實標示為 `queued`；一般 task audit 不會離線假裝已保存。

## MCP 工具

Plugin 也提供 `memlume` MCP Server，讓 Claude Code 可呼叫 `memlume.resolve_context`、`memlume.record_event`、`memlume.remember` 與 `memlume.search`。MCP Server 會使用同一份安全 token，但它只處理明確工具呼叫；回合生命週期仍由上述 hooks 負責。

## 驗證

```powershell
pnpm run test:claude-code
claude plugin validate ./adapters/claude-code
```

第一個指令以 fake daemon 執行真實 Plugin script，驗證三個 lifecycle mapping、context 優先序、敏感 token 不外洩與 SessionEnd outbox flush。第二個指令使用已安裝的 Claude Code 驗證 manifest 與 hook 設定。
