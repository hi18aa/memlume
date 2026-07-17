# OpenClaw Adapter

OpenClaw Adapter 透過 `adapters/openclaw` 的 typed hooks 連到 loopback daemon。v0.3 的 workspace binding 與 Brain Router 由 daemon 管理，OpenClaw 不需要把 Project Brain UUID 寫入 prompt 或 adapter 程式。

## 什麼時候值得使用

如果 OpenClaw 需要與其他 Agent 共用專案決策、工具偏好或個人設定，這個 Plugin 會在 prompt 建立前讀取相關 Context，並把使用者訊息交給同一條 Core capture pipeline。你只要提供 installation、profile 與 workspace；公司、團隊或產品內容直接建立成 Project。OpenClaw 原生記憶與 transcript 不會被 Memlume 讀取或覆寫。

v0.3 的重點不是讓 OpenClaw 看到更多內容，而是讓 daemon 選對 Personal／Primary Project／命中的 Linked Project，並且在不確定時進 Inbox，不污染其他 Brain。

最短流程：啟動 daemon → 執行 `setup adapter openclaw` → link、enable 並重啟 Plugin → 開啟 `allowPromptInjection` → 正常工作 → 用 `memlume doctor` 檢查 hook heartbeat。

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
- profile-level document attachment 若已通過 Brain mount，會在同一個 budget 內提供唯讀 Markdown sections；只有已 sync 的 active revision 能被注入，普通聊天不會污染文件。
- Hook 統一遵守 500ms fail-open contract；`beforeTask` 先讀取 250ms 內的 Context，outbox retry 在讀取完成後以背景工作執行，不阻塞 OpenClaw 原生流程。
- `message_received` 呼叫 `onUserMessage`。Core 會過濾 Secret、拆分 atom、解析 Personal／Project、檢查衝突，再以 Markdown authority → SQLite projection 寫入。
- `subagent_spawned` 是 observer，只記錄 child 啟用訊號；child 第一次 `before_prompt_build` 才呼叫 `onSubagentStart`。沒有 child goal 時只讀 Primary Project，不讀取 Personal 或未匹配 Linked Project，也不寫入。

未知或模糊 Project 不會自動建立，也不會回退 Personal，而會進 durable routing Inbox。一般陳述可為 `candidate`，明確授權才可能成為 `active`；事件可為 `event_only`，問候與閒聊則 `ignored`。每個 atom 都有 capture receipt，可用 `memlume status` 查詢 routing／queue 狀態。

Assistant final 不直接成為記憶。daemon 只在 `.runtime` 暫存最多 64 KiB、24 小時；「可以／同意」會在有效 final buffer 存在時重新路由，「修正」會走 supersedes/conflict 流程。短回覆沒有有效 buffer 時忽略；runtime 資料不進 Brain、FTS、Inbox、outbox 或 backup。

## 離線與安全

設定 `allowPromptInjection` 後才會向 OpenClaw 注入 Context；daemon 不可用時 Adapter fail-open，OpenClaw 原生流程仍可繼續。outbox 只保留安全且明確的 capture，`beforeTask` 讀取完成後會背景重送，下一次 `beforeTask` 或 `onUserMessage` 仍會再次重試，沒有 silent eviction。token、完整 transcript、assistant 推理與 Secret 不會寫入 outbox 或記憶。

```powershell
node apps/cli/dist/index.js doctor
```

看到 daemon health、read/write 與 callback heartbeat 正常，才代表 OpenClaw 實際啟用。OpenClaw native memory 不會被 Memlume 讀取、覆寫或同步。
