# Memlume Host Adapters

這個目錄提供 Hermes、Codex、OpenClaw、Claude Code 的最小 Host 整合。四個 Adapter 共用同一個 `@memlume/adapter-sdk` 與本機 daemon；差異只在各 Host 的 hook／plugin 事件，不在記憶資料或 Brain 路由。

## v0.3 共用原則

Adapter 不再把固定 Project Brain UUID 當成寫入目標。Host 只送出 callback、workspace、session、task 與證據；daemon 依 workspace binding 與 mount 權限產生 ReadSet 或選擇寫入 Brain。

| Callback | 用途 |
| --- | --- |
| `beforeTask` | 任務前讀取 daemon 產生的最小 ReadSet；讀取失敗時回空 Context，Host 繼續工作。 |
| `onUserMessage` | 自動 capture 入口；Core 負責 Secret filter、atomization、routing、conflict 與 Markdown-first 寫入。 |
| `onSubagentStart` | 子代理讀取受限 ReadSet；沒有 child goal 時只允許 Primary Project，不寫入或 flush outbox。 |

### 初始化

```powershell
node apps/cli/dist/index.js init --path <workspace>
node apps/cli/dist/index.js setup adapter <hermes|codex|openclaw|claude-code> `
  --installation-id <stable-id> --workspace-path <workspace> `
  --core-path <memlume-core> --install-host --yes
```

需要自訂 Project 時，可使用：

```powershell
node apps/cli/dist/index.js project create <name>
node apps/cli/dist/index.js project bind <brain-id> --path <workspace> --role primary
node apps/cli/dist/index.js project alias <brain-id> <alias>
node apps/cli/dist/index.js project inspect --path <workspace>
```

`--project-id` 與 `--brain-id` 僅保留 v0.2 相容模式；新安裝應省略它們，讓 workspace-owned routing 發揮作用。

## 自動 capture 與 routing Inbox

使用者訊息不必加上「記錄到 Memlume」。Core 會先過濾 Secret，將多主題訊息拆成 atom，再依 Personal／Primary Project／Linked Project 路由。明確且無衝突的命題可成為 `active`；推測是 `candidate`；事件是 `event_only`；未知或模糊 Project 進 durable `routing Inbox`，不會猜測或回退 Personal。SQLite 是索引投影，Markdown records 才是可恢復 authority。

Assistant final 不會直接成為 active memory。daemon 只在 `.runtime` 保留安裝、session、turn、trace 與 final answer（最多 64 KiB、24 小時）；「可以／同意」或「修正」會在有效 buffer 存在時重新走 atomization、routing 與 supersedes 流程。runtime 不進 Brain、FTS、Inbox、outbox 或 backup。

## Adapter 邊界

- 不讀取、覆寫或同步 Host native memory。
- 不自行產生 Brain UUID、不猜測未知 Project、不把未驗證 assistant output 寫入 active。
- 不建立第二個 retry queue；SDK outbox 只保留安全且明確的 capture，queue full、routing_required、rejected 與 degraded 都必須可見。
- 不保存完整 transcript、tool transcript、暫時推理、token 或 Secret。

使用 `memlume status` 查看 callback heartbeat、ReadSet／capture／routing 狀態；使用 `memlume doctor` 檢查 daemon health、mount、read/write smoke 與實際啟用。各 Host 的詳細 hook 差異請參閱 `docs/guides/` 下的 Hermes、Codex、OpenClaw 與 Claude Code 指南。
