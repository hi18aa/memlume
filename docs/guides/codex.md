# Codex Adapter

Codex Adapter 由 `adapters/codex/hooks/memlume.mjs` 呼叫共用 Adapter SDK，並以官方 Plugin Marketplace manifest 提供安裝入口。

```powershell
node apps/cli/dist/index.js --setup-token $env:MEMLUME_SETUP_TOKEN setup adapter codex `
  --installation-id codex-desktop --project-id memlume `
  --brain-id '<project-brain-uuidv7>' --core-path $PWD --install-host --yes
```

`--install-host --dry-run` 可預覽不含 token 的 marketplace/hook 命令。Codex 仍會要求使用者信任 hook；Memlume 不會代替 Codex 放寬信任。

`UserPromptSubmit` 先以 `beforeTask` 讀取主 Agent 的已掛載 Context，預設優先序為 **Project → Domain（Company）→ Personal**，再暫時注入本回合。它同時以 `onUserMessage` 送出使用者訊息；只有明確「記住」類要求才可能由 Core 形成 memory，一般訊息可被忽略。主 Agent 寫入採明確 Brain → profile Project Brain → 拒絕，絕不回退 Personal。

Codex Plugin 目前沒有可用的 child-start Hook，所以不會自動為子代理注入 Shared Context，也不會偽造事件、解析 transcript 或猜測 session ID。SDK 的受限 `onSubagentStart` 入口已準備好供未來官方 Hook 或外部 orchestration 使用；目前只保證主 Agent 的正常流程。

Codex 的 native memory 不會搬到 Memlume。未掛載時 daemon 直接 endpoint 會回 `403 forbidden`，Adapter SDK 則以空 Context fail-open。暫時離線的明確記憶會在下一次 `beforeTask` 或 `onUserMessage` 重送；完整 transcript、assistant output、暫時推理與秘密資料不會被自動保存。
