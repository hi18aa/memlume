# Claude Code Adapter

Claude Code 使用 `adapters/claude-code/.claude-plugin` 與 hooks/MCP 設定接入 Memlume。先建立 profile，再使用官方本機 Plugin manifest：

```powershell
node apps/cli/dist/index.js --setup-token $env:MEMLUME_SETUP_TOKEN setup adapter claude-code `
  --installation-id claude-desktop --project-id memlume `
  --brain-id '<project-brain-uuidv7>' --core-path $PWD --install-host --yes
claude plugin validate .\adapters\claude-code
```

主 Agent 的 `UserPromptSubmit` 以 `beforeTask` 讀取已掛載 Context，預設優先序為 **Project → Domain（Company）→ Personal**，並以官方 `additionalContext` 暫時注入。它也會以 `onUserMessage` 交給 Core 處理使用者訊息；只有明確「記住」類要求才可能形成 memory，一般訊息可被忽略。主 Agent 寫入採明確 Brain → profile Project Brain → 拒絕，永不回退 Personal。

Claude Code 的 `SubagentStart` 可直接注入 Context：Adapter 會呼叫只讀的 `onSubagentStart`，只提供 Project Brain，不會讀取 Domain 或 Personal，也不會寫入或 flush outbox。這與主 Agent 的 mount 優先序刻意分開；Brain 是權限邊界，Hook 只決定觸發時機。

Claude Code 可使用 `memlume.record_event` 保存刻意呼叫的不可變證據，並以 Context Pack 的 `traceId` 呼叫 `memlume.record_memory_usage`／`memlume.record_outcome` 回報結果。`memlume.remember` 建立的是 reviewable candidate，避免外部 prompt 直接製造 active policy；請在 Console 或受保護 inbox 逐筆核准。

平台仍會要求使用者信任 hooks。daemon 不可用時，讀取會 fail-open，Claude Code 的 native memory 與其他原生設定不受影響；暫時離線的明確記憶會在下一次 `beforeTask` 或 `onUserMessage` 重送，不會自動保存完整 transcript、assistant output、暫時推理或秘密資料。
