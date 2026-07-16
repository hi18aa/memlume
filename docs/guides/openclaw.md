# OpenClaw Adapter

OpenClaw Adapter 透過 `adapters/openclaw` 的 typed hooks 連到 loopback daemon。v0.3 的 workspace binding 與 Brain Router 由 daemon 管理，OpenClaw 不需要把 Project Brain UUID 寫入 prompt 或 adapter 程式。

## 設定

```powershell
$env:MEMLUME_SETUP_TOKEN = '<setup-token>'
node apps/cli/dist/index.js init --path $PWD
node apps/cli/dist/index.js setup adapter openclaw `
  --installation-id openclaw-desktop `
  --workspace-path $PWD `
  --core-path $PWD --install-host --yes
node apps/cli/dist/index.js status
```

需要手動建立 Project 時，可使用 `memlume project create <name>`、`project bind <brain-id> --path <workspace> --role primary` 與 `project alias`。v0.2 的 `--project-id`／`--brain-id` 只作相容模式；一般安裝應讓 workspace binding 決定路由。

## Hook 與讀寫

- `before_prompt_build` 呼叫 `beforeTask`，Core 依目前 workspace、任務與 entity 產生 ReadSet。Primary Project 優先，只有命中的 Linked Project 才加入；Personal 需具相關性才注入。
- `message_received` 呼叫 `onUserMessage`。Core 會過濾 Secret、拆分 atom、解析 Personal／Project、檢查衝突，再以 Markdown authority → SQLite projection 寫入。
- `subagent_spawned` 是 observer，只記錄 child 啟用訊號；child 第一次 `before_prompt_build` 才呼叫 `onSubagentStart`。沒有 child goal 時只讀 Primary Project，不讀取 Personal 或未匹配 Linked Project，也不寫入。

未知或模糊 Project 不會自動建立，也不會回退 Personal，而會進 durable routing Inbox。一般陳述可為 `candidate`，明確授權才可能成為 `active`；事件可為 `event_only`，問候與閒聊則 `ignored`。每個 atom 都有 capture receipt，可用 `memlume status` 查詢 routing／queue 狀態。

Assistant final 不直接成為記憶。daemon 只在 `.runtime` 暫存最多 64 KiB、24 小時；「可以／同意」會在有效 final buffer 存在時重新路由，「修正」會走 supersedes/conflict 流程。短回覆沒有有效 buffer 時忽略；runtime 資料不進 Brain、FTS、Inbox、outbox 或 backup。

## 離線與安全

設定 `allowPromptInjection` 後才會向 OpenClaw 注入 Context；daemon 不可用時 Adapter fail-open，OpenClaw 原生流程仍可繼續。outbox 只保留安全且明確的 capture，下一次 `beforeTask` 或 `onUserMessage` 重送，沒有 silent eviction。token、完整 transcript、assistant 推理與 Secret 不會寫入 outbox 或記憶。

```powershell
node apps/cli/dist/index.js doctor
```

看到 daemon health、read/write 與 callback heartbeat 正常，才代表 OpenClaw 實際啟用。OpenClaw native memory 不會被 Memlume 讀取、覆寫或同步。
