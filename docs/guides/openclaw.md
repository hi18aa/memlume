# OpenClaw Adapter

OpenClaw Adapter 透過 `adapters/openclaw` 的 typed Hook 連到 loopback daemon。安裝與檢查：

```powershell
node apps/cli/dist/index.js --setup-token $env:MEMLUME_SETUP_TOKEN setup adapter openclaw `
  --installation-id openclaw-desktop --project-id memlume `
  --brain-id '<project-brain-uuidv7>' --core-path $PWD --install-host --yes
node apps/cli/dist/index.js doctor
```

Adapter 設定只放 daemon URL、profile 與 token 參照；不會把 token 寫入 OpenClaw 的一般設定或 prompt。設定 `allowPromptInjection` 後，主 Agent 的 `before_prompt_build` 會以 `beforeTask` 讀取已掛載 Context，預設優先序為 **Project → Domain（Company）→ Personal**，並暫時注入背景參考。`message_received` 會以 `onUserMessage` 將使用者訊息交給 Core；只有明確「記住」類要求才可能形成 memory，一般訊息可被忽略。主 Agent 寫入採明確 Brain → profile Project Brain → 拒絕，絕不回退 Personal。

`subagent_spawned` 只是 observer：它只登錄 child 識別值，不寫入 memory 或 flush outbox。child 的第一次 `before_prompt_build` 才呼叫只讀的 `onSubagentStart`，只取得 Project Brain Context，不會讀取 Domain 或 Personal。Brain 是資料歸屬與權限邊界，Hook 只決定觸發時機。

沒有 mount 的 OpenClaw 不能讀取或寫入該 Brain；直接 API 會回 `403 forbidden`，Adapter SDK 則 fail-open。若要暫停共享腦，只需停止 daemon；OpenClaw 原生流程仍可使用空 Context 繼續。暫時離線的明確記憶會在下一次 `beforeTask` 或 `onUserMessage` 重送；完整 transcript、assistant output、暫時推理與秘密資料不會被自動保存。
