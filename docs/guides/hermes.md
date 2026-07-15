# Hermes Adapter

Hermes Adapter 使用 `adapters/hermes/bridge.mjs` 與 Python plugin，將 Hermes 的 Hook 差異轉成 Memlume Core 的共用 Adapter SDK。

## 設定

先建置 Core，並用 CLI 建立 Hermes profile：

```powershell
pnpm install --frozen-lockfile
pnpm build
node apps/cli/dist/index.js --setup-token $env:MEMLUME_SETUP_TOKEN setup adapter hermes `
  --installation-id hermes-desktop --project-id memlume `
  --brain-id '<project-brain-uuidv7>' --core-path $PWD --install-host --yes
```

Profile 會放在使用者設定目錄；token 不會寫入 Git。`MEMLUME_DAEMON_URL`、`MEMLUME_TOKEN`、`MEMLUME_HOME` 等變數可覆寫 profile。

## 流程

主 Agent 的 `pre_llm_call` 會以 `beforeTask` 讀取已掛載 Context，預設優先序為 **Project → Domain（Company）→ Personal**；也會以 `onUserMessage` 將非敏感使用者訊息送到 Core 並追加 immutable event。依治理規則，非明確陳述可成為待審核 `candidate`，明確「記住」類要求可走 `active` 路徑，仍可能需衝突審核。空白或不支援事件可被 ignore，秘密資料會 redacted 或 rejected。主 Agent 寫入採明確 Brain → profile Project Brain → 拒絕，絕不回退 Personal。

Hermes 的 `subagent_start` 是 observer：它只登錄 child 識別值，不會直接注入 Context、寫入記憶或 flush outbox。child 的第一次 `pre_llm_call` 才呼叫只讀的 `onSubagentStart`，且只取得 Project Brain Context，不會讀取 Domain 或 Personal。Brain 是資料歸屬與權限邊界，Hook 只決定觸發時機。

暫時離線時，installation-specific outbox 僅接受安全且不含秘密的明確記憶 capture，並在下一次 `beforeTask` 或 `onUserMessage` 重送。完整 transcript、assistant output、暫時推理與秘密資料不會自動保存。Hermes 原生記憶仍由 Hermes 自己管理。

## 檢查

```powershell
node apps/cli/dist/index.js doctor
```

看到 `read: ok` 且 `write: ok` 才代表 mount 與 token 可用。只要 Shared Brain 不可用，Hermes 仍可使用自身原生功能。
