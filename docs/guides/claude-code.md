# Claude Code Adapter

Claude Code 使用 `adapters/claude-code/.claude-plugin` 與 hooks/MCP 設定接入 Memlume。先建立 profile，再使用官方本機 Plugin manifest：

```powershell
node apps/cli/dist/index.js --setup-token $env:MEMLUME_SETUP_TOKEN setup adapter claude-code `
  --installation-id claude-desktop --project-id memlume `
  --brain-id '<project-brain-uuidv7>' --core-path $PWD --install-host --yes
claude plugin validate .\adapters\claude-code
```

Claude Code 會在每回合開始前解析 Context Pack，使用 `memlume.record_event` 保存不可變證據，並以該次 Context Pack 的 `traceId` 呼叫 `memlume.record_memory_usage`／`memlume.record_outcome` 回報結果。`memlume.remember` 建立的是 reviewable candidate，避免外部 prompt 直接製造 active policy；請在 Console 或受保護 inbox 逐筆核准。

平台仍會要求使用者信任 hooks。停止 daemon 時 hook fail-open，Claude Code 的 native memory 與其他原生設定不受影響。
