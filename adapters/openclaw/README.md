# Memlume OpenClaw Plugin

此 Native Plugin 將 OpenClaw 回合接到同一台電腦上的 Memlume Shared Brain。它不會讀取、修改或取代 OpenClaw 原生記憶、Markdown 記憶或 session transcript；Memlume 只提供可掛載、可備份並能與其他 Agent 共用的外部記憶層。

## 安裝

Plugin 會從已 checkout 的 Memlume repository 載入已建置的 Adapter SDK。因此開發與本機使用請以 link 安裝，不要把 `adapters/openclaw` 單獨複製到其他位置：

```powershell
pnpm --filter @memlume/adapter-sdk build
openclaw plugins install --link ./adapters/openclaw
openclaw plugins enable memlume-openclaw
openclaw gateway restart
openclaw plugins inspect memlume-openclaw --runtime --json
```

OpenClaw Plugin 是可執行程式碼。請只 link 你信任的 checkout，並使用 `--runtime` inspect 確認 Gateway 載入的 hook。

## 設定

先以 `memlume setup adapter openclaw` 建立本機 profile。Plugin 從該 profile 讀取個別 adapter token，因此 token 不會放入 `openclaw.plugin.json`、OpenClaw 設定檔或 Git。`MEMLUME_TOKEN` 仍可作為暫時環境覆寫。

OpenClaw 設定中的 `corePath` 必須是完整 Memlume repository；Plugin 會確認實際載入的 SDK 仍在此目錄內。`daemonUrl`（預設 `http://127.0.0.1:3849`）與 `outboxDirectory` 可選填。

再於 OpenClaw 設定檔中填入非秘密的安裝身分與 Brain。下例同時明確開啟兩項必要 hook 權限：

```json
{
  "plugins": {
    "allow": ["memlume-openclaw"],
    "entries": {
      "memlume-openclaw": {
        "enabled": true,
        "hooks": {
          "allowPromptInjection": true
        },
        "config": {
          "installationId": "your-installation-id",
          "profileId": "default",
          "projectId": "your-project-id",
          "brainId": "your-project-brain-uuidv7",
          "corePath": "C:/work/memlume",
          "workspacePath": "C:/work/memlume"
        }
      }
    }
  }
}
```

`allowPromptInjection` 為 `false` 時，OpenClaw 會封鎖 `before_prompt_build` 的 Shared Context 注入。設定後請重啟 Gateway。

## Hook 對應

| OpenClaw typed hook | Memlume 行為 |
| --- | --- |
| `before_prompt_build` | 呼叫 `beforeTask`，以 bounded Shared Context 回傳暫時 `prependContext`。內容明確是背景參考，系統、developer 與當前使用者指示永遠優先。 |
| `message_received` | 呼叫 `onUserMessage`，將使用者訊息交給 Core 編譯與治理。 |
| `subagent_spawned` | 只登錄子代理 session；子代理的第一個 `before_prompt_build` 會呼叫受 Project Brain 限制的 `onSubagentStart`。 |

例如使用者說「`記住專案使用 pnpm`」時，Plugin 會以設定的 Project scope 與 Brain 交給 Memlume Core。Core 仍負責敏感資料過濾、候選審核、衝突處理與 mount 權限；Plugin 不能宣稱寫入已成功，也不會把 OpenClaw 私有記憶同步到 Memlume。

若 daemon 暫時不可用，Shared Context 讀取會 fail-open，OpenClaw 照常執行。只有明確記憶請求會由 SDK 放進本機 outbox。

## 驗證

```powershell
pnpm run test:openclaw
```

測試以 fake Native Plugin API 與 fake Adapter SDK 驗證四個 lifecycle mapping、優先序界線、缺少設定的 fail-open 行為與 package manifest。
