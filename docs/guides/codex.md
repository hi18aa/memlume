# Codex Adapter

Codex Adapter 由 `adapters/codex/hooks/memlume.mjs` 呼叫共用 Adapter SDK，並以官方 Plugin Marketplace manifest 提供安裝入口。

```powershell
node apps/cli/dist/index.js --setup-token $env:MEMLUME_SETUP_TOKEN setup adapter codex `
  --installation-id codex-desktop --project-id memlume `
  --brain-id '<project-brain-uuidv7>' --core-path $PWD --install-host --yes
```

`--install-host --dry-run` 可預覽不含 token 的 marketplace/hook 命令。Codex 仍會要求使用者信任 hook；Memlume 不會代替 Codex 放寬信任。

`UserPromptSubmit` 先以 `beforeTask` 讀取主 Agent 的已掛載 Context，預設優先序為 **Project → Domain（Company）→ Personal**，再暫時注入本回合。它同時以 `onUserMessage` 將符合資格且非敏感的使用者訊息送到 Core 並追加 immutable event；一般陳述可能成為待審核 `candidate`，明確「記住」類要求可走 `active` 路徑，仍須經過衝突審核。空白或不支援事件會被 ignore，敏感資料會 redacted 或 rejected。主 Agent 寫入採明確 Brain → profile Project Brain → 拒絕，絕不回退 Personal。

## 子代理 Context

Codex 的官方 [`SubagentStart`](https://learn.chatgpt.com/docs/hooks#subagentstart) hook 會直接以 `additionalContext` 注入受限的 Project Brain Context。此事件只呼叫 `onSubagentStart` 解析 Context，`task` 固定為 `null`。

- 只讀取設定的 Project Brain，絕不回退到 Domain 或 Personal。
- 不讀取或傳送 transcript、agent type、prompt 或 Codex native memory，也不會同步原生記憶。
- 不執行 capture、不寫入 Core，也不會 flush outbox。
- daemon、設定或 Context 不可用時會 fail-open，以空 Context 繼續，不阻斷 Codex。

Codex 的 native memory 不會搬到 Memlume。未掛載時 daemon 直接 endpoint 會回 `403 forbidden`，Adapter SDK 則以空 Context fail-open。本機 outbox 僅接受明確記憶 capture，並在下一次 `beforeTask` 或 `onUserMessage` 重送；完整 transcript、assistant output、暫時推理與秘密資料不會被自動保存。
