# Claude Code Adapter

Claude Code 使用 `adapters/claude-code/.claude-plugin` 與 hooks/MCP 接入 Memlume。v0.3 由 daemon 依 workspace binding 產生 ReadSet；Adapter 不持有靜態 Project Brain，也不同步 Claude Code native memory。

## 設定

```powershell
$env:MEMLUME_SETUP_TOKEN = '<setup-token>'
node apps/cli/dist/index.js init --path $PWD
node apps/cli/dist/index.js setup adapter claude-code `
  --installation-id claude-desktop `
  --workspace-path $PWD `
  --core-path $PWD --install-host --yes
claude plugin validate .\adapters\claude-code
```

可用 `memlume project create`、`project bind` 與 `project alias` 管理 workspace 的 Project。`--project-id`／`--brain-id` 僅為 v0.2 相容選項；v0.3 應讓 daemon-owned routing 決定 Brain。

## 自動讀寫

- `UserPromptSubmit` 先以 `beforeTask` 讀取最小 ReadSet，並透過官方 `additionalContext` 暫時注入。ReadSet 以 Primary Project 為核心，依任務命中加入 Linked Project，Personal 只在相關時加入。
- 同一使用者訊息以 `onUserMessage` 進入自動 capture。Core 先執行 Secret filter、admission、atomization、Brain Router 與 activation，再 append Markdown record、投影 SQLite。
- 明確穩定命題才可能成為 `active`；推測是 `candidate`，事件是 `event_only`。未知／模糊 Project 進 durable routing Inbox，不建立新 Brain、不寫入 Personal。
- `SubagentStart` 呼叫 `onSubagentStart`，沒有 child goal 時只注入 Primary Project；不讀取 Personal、未匹配 Linked Project、transcript 或 Claude native memory，也不寫入或 flush outbox。

## Assistant final 與明確工具

Assistant final 只會在 daemon `.runtime` 暫存 64 KiB／24 小時，不會直接建立 active memory。下一個使用者回覆「可以／同意」且 buffer 尚未過期時，Core 才重新 atomize、路由並依使用者授權寫入；「修正」會建立 superseding record。沒有有效 final buffer 的短回覆會被忽略。

`memlume.remember`、`memlume.record_event`、`memlume.review`、`memlume.record_memory_usage` 與 `memlume.record_outcome` 是明確操作／稽核工具，不是自動 capture 的替代品。Outcome 只關閉 receipt，不改變 memory 排序或狀態。

## 檢查與安全

```powershell
node apps/cli/dist/index.js status
node apps/cli/dist/index.js doctor
```

daemon 不可用時讀取 fail-open；只有安全且明確的 capture 進本機 outbox，下一個 `beforeTask` 或 `onUserMessage` 重送。完整 transcript、assistant 推理、token 與 Secret 不會進 Brain、FTS、Inbox、outbox 或 backup。Claude Code 仍會要求使用者信任 hooks，native memory 與原生設定保持不變。
