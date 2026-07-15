# Memlume Claude Code Plugin

此 Plugin 讓 Claude Code 讀寫同一台電腦上的 Memlume Shared Brain。它不會讀取、修改或取代 Claude 的 `CLAUDE.md`、原生設定、session transcript 或其他原生記憶；Memlume 是獨立、可掛載、可備份、可由其他 Agent 共用的外部記憶層。

## 本機測試與安裝

先建置 Memlume Core。開發時可用 Claude Code 的 `--plugin-dir` 載入本資料夾，而不需要先建立 Marketplace：

```powershell
pnpm --filter @memlume/adapter-sdk build
pnpm --filter @memlume/mcp-server build
claude --plugin-dir ./adapters/claude-code
```

建議先以 `memlume setup adapter claude-code` 建立本機 profile。Plugin 在未提供 userConfig 時會安全讀取該 profile；若在 Claude Code 填入設定，尤其是 `Memlume adapter token`，`userConfig.sensitive` 會優先使用 Claude Code 的安全儲存空間，不會寫入 `plugin.json`、`.mcp.json`、Git 或 Plugin 日誌。

`memlume_home` 必須是完整的 Memlume repository；Plugin 會確認實際載入的 Adapter SDK 與 MCP Server 都仍位於該目錄內。`daemon_url` 預設為 `http://127.0.0.1:3849`，且 Core 只接受 loopback 位址。

## 每一回合怎麼運作

| Claude Code hook | Memlume 行為 |
| --- | --- |
| `UserPromptSubmit` | 以 `beforeTask` 讀取已掛載的 **Project → Domain（Company）→ Personal** Shared Context，使用官方 `additionalContext` 暫時提供給主 Agent；同時在獨立本機工作中以 `onUserMessage` 送出使用者訊息。 |
| `SubagentStart` | 直接呼叫只讀的 `onSubagentStart`，以官方 `additionalContext` 注入受限的 Project Brain Context；不寫入記憶，也不會讀取 Domain 或 Personal。 |

非敏感使用者訊息會以設定的 Project scope 與 Brain 送到 Memlume Core，並追加 immutable event。依治理規則，非明確陳述可成為待審核 `candidate`；例如使用者說「`記住專案使用 pnpm`」時，明確要求可走 `active` 路徑，仍可能需衝突審核。空白或不支援事件可被 ignore，秘密資料會 redacted 或 rejected。敏感資料過濾、衝突治理與 mount 權限都只能由 Core 決定。

Shared Context 明確標記為背景參考；系統、developer 與當前使用者指示永遠優先。Plugin 不會以 Shared Context 覆蓋 Claude 原生記憶，也不會把 Claude 原生記憶複製進 Memlume。

當 daemon 暫時無法使用時，context 讀取會 fail-open，Claude Code 會照常工作。本機 outbox 僅接受明確記憶 capture，並如實標示為 `queued`；它會在下一次 `beforeTask` 或 `onUserMessage` 重送。完整 transcript、assistant output 與暫時推理不會離線保存。

## MCP 工具

Plugin 也提供 `memlume` MCP Server，讓 Claude Code 可呼叫 `memlume.resolve_context`、`memlume.record_event`、`memlume.remember` 與 `memlume.search`。MCP Server 會使用同一份安全 token，但它只處理明確工具呼叫；回合生命週期仍由上述 hooks 負責。

## 驗證

```powershell
pnpm run test:claude-code
claude plugin validate ./adapters/claude-code
```

第一個指令以 fake daemon 執行真實 Plugin script，驗證兩個實際 Hook mapping、主 Agent Context 優先序、子代理 Project Brain 限制、outbox 重送與敏感 token 不外洩。第二個指令使用已安裝的 Claude Code 驗證 manifest 與 hook 設定。
