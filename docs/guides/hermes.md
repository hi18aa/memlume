# Hermes Adapter

Hermes Adapter 使用 `adapters/hermes/bridge.mjs` 與 Python plugin，把 Hermes 的生命週期事件轉成 Memlume Core 的三個共用 callback。它不維護第二份 Brain，也不需要在每次訊息中手動說「記錄到 Memlume」。

## 設定

先啟動 daemon，初始化 workspace binding，再建立不含靜態 Brain UUID 的 v0.3 profile：

```powershell
$env:MEMLUME_SETUP_TOKEN = '<setup-token>'
node apps/cli/dist/index.js init --path $PWD
node apps/cli/dist/index.js setup adapter hermes `
  --installation-id hermes-desktop `
  --workspace-path $PWD `
  --core-path $PWD --install-host --yes
```

需要手動建立 Project 時，可先執行 `memlume project create <name>`、`memlume project bind <brain-id> --path <workspace> --role primary`，再執行 Adapter setup。`--project-id` 與 `--brain-id` 僅是 v0.2 相容選項；v0.3 預設由 workspace binding 路由。

Profile 與 token 只放在使用者設定目錄，不應提交 Git。`MEMLUME_DAEMON_URL`、`MEMLUME_TOKEN`、`MEMLUME_HOME` 與 `MEMLUME_WORKSPACE_PATH` 可覆寫 profile。

## 自動流程

- Hermes 的 `pre_llm_call` 以 `beforeTask` 讀取 daemon 依 workspace 產生的 ReadSet。通常包含 Primary Project；任務或 entity 命中時才加入 Linked Project，必要時才加入 Personal。
- Hermes 的使用者訊息以 `onUserMessage` 送入自動 capture。Core 會先過濾 Secret，再拆 atom、解析 Personal／Project 路由、檢查衝突，最後寫 Markdown authority 並投影 SQLite。
- 未知或模糊 Project 會進 durable routing Inbox，不會靜默寫入 Personal。普通陳述可為 `candidate`，明確「記住」才可能成為 `active`；問候、閒聊與秘密會被忽略或拒絕。
- `subagent_start` 只觀察 child；child 第一次支援的 `pre_llm_call` 才呼叫 `onSubagentStart`，沒有 child goal 時只讀 Primary Project，不寫入或 flush outbox。

Hermes assistant final 不會直接進 Brain。Core 會在 `.runtime` 暫存最多 64 KiB、24 小時；下一個使用者回覆「可以／同意」時，只有存在有效 buffer 才會重新路由並寫入。`修正` 會建立 superseding record；沒有 buffer 或已過期則忽略。

## 離線與檢查

daemon 暫時不可用時，Adapter SDK fail-open，Hermes 繼續使用原生功能；只有安全且明確的 capture 會進 outbox，下一次 `beforeTask` 或 `onUserMessage` 重送。完整 transcript、assistant 推理、token 與秘密不會寫入 outbox、Brain 或 backup。

```powershell
node apps/cli/dist/index.js status
node apps/cli/dist/index.js doctor
```

`status` 可查看 routing／queue／Host callback 狀態；`doctor` 的 read/write 與 heartbeat 通過後，才代表該 installation 已實際啟用。Hermes 原生記憶仍由 Hermes 自己管理，Memlume 只提供跨 Host 共用 Brain。
