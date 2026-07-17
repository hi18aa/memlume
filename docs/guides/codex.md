# Codex Adapter

Codex Adapter 由 `adapters/codex/hooks/memlume.mjs` 呼叫共用 Adapter SDK，並透過官方 Plugin manifest 安裝。v0.3 不把 Project Brain UUID 寫死在 hook；daemon 依目前 workspace binding 產生正確 ReadSet。

## 什麼時候值得使用

如果你在 Codex、Hermes、Claude Code 或 OpenClaw 之間切換，想讓「我偏好 Vue」這類個人資訊與「這個專案使用 pnpm」這類專案資訊被正確分開，Codex Plugin 就是自動入口。設定一次 workspace 後，Codex 在每個 prompt 前讀取相關 Context，使用者訊息由 Core 自動判斷是否保存；不需要手動指定 Brain，也不需要每次說「記錄到 Memlume」。公司、團隊或產品內容請當成 Project。

Codex 原生記憶與設定仍保持不變。Memlume 只提供可追溯、可備份、可與其他 Host 共用的外部記憶層。

最短流程：啟動 daemon → 執行 `setup adapter codex` → 安裝並信任 Plugin → 正常工作 → 用 `memlume status`／`doctor` 檢查讀寫。

## 設定

```powershell
$env:MEMLUME_SETUP_TOKEN = '<setup-token>'
node apps/cli/dist/index.js init --path $PWD
node apps/cli/dist/index.js setup adapter codex `
  --installation-id codex-desktop `
  --workspace-path $PWD `
  --core-path $PWD --install-host --yes
```

`--install-host --dry-run` 可預覽安裝命令；Codex 仍會要求使用者信任 hook，Memlume 不會代替 Codex 放寬信任。若要手動管理 Project，使用 `memlume project create`、`project bind` 與 `project alias`。舊版 `--project-id`／`--brain-id` 仍可作相容設定，但不應作為 v0.3 自動路由的主要方式。

## 主 Agent 流程

Codex 的 `UserPromptSubmit` 先呼叫 `beforeTask`。daemon 依 workspace、任務、intent 與 entities 產生最小 ReadSet：Primary Project 必須優先，命中的 Linked Project 才會加入，Personal 只有在內容與任務相關時才加入。Host 不可自行要求未掛載或未匹配的 Brain。

已掛載 Project Brain 的 profile 若另有 document attachment，文件 sections 會在同一個 context budget 內以 active、可引用的方式加入；source root 必須先由 setup API 明確 sync，普通 capture 不會寫入文件。

Codex 可用 `propose` mount 提交完整 Markdown body 的 pending proposal，但不能自行 review/apply；只有 `read_write` installation 能核准並以 atomic rename 套用。每次搜尋與 Context 都先檢查 source manifest，`drift` 或 `repair_required` 會阻擋舊 sections，修正後需重新 sync。

同一個使用者訊息再由 `onUserMessage` 自動 capture。Core 會執行 Secret filter、admission、atomization、Brain Router 與 activation；使用者不需要重複說「記錄到 Memlume」。

- 明確穩定的使用者偏好、事實或決策可成為 `active`，衝突時停在 review。
- 推測內容是 `candidate`，時間軸事件可為 `event_only`。
- 未知／模糊 Project 進 durable routing Inbox，不建立 Brain，也不回退 Personal。
- 問候、閒聊與 Secret 會 `ignored` 或 `rejected`；每個 atom 先寫 Markdown，再投影 SQLite。

## 子代理與短回覆

Codex 的官方 `SubagentStart` hook 透過 `additionalContext` 呼叫 `onSubagentStart`。沒有 child goal 時只注入 Primary Project；不讀取 Personal、未匹配 Linked Project、transcript 或 Codex native memory，也不寫入或 flush outbox。daemon 不可用時 fail-open 為空 Context。

Assistant final 僅短期存於 daemon `.runtime`（64 KiB、24 小時），不會進 Brain、FTS、Inbox、outbox 或 backup。下一個使用者回覆「可以／同意」會在有效 buffer 存在時重新 atomize、路由並授權寫入；「修正」會沿用 supersedes/conflict 流程。單獨的「可以」或過期 buffer 會被忽略。

## 檢查與離線

```powershell
node apps/cli/dist/index.js status
node apps/cli/dist/index.js doctor
```

`status` 顯示 ReadSet／routing Inbox／capture queue 與 Host callback 狀態；`doctor` 用 heartbeat、read/write smoke 檢查實際啟用。daemon 暫時離線時，SDK 只把安全且明確的 capture 排入 outbox，之後由 `beforeTask` 或 `onUserMessage` 重送；完整 transcript、assistant output、推理與秘密資料不會自動保存。Codex native memory 保持原狀。
