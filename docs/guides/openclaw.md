# OpenClaw Adapter

OpenClaw Adapter 透過 `adapters/openclaw` 的 lifecycle hooks 連到 loopback daemon。安裝與檢查：

```powershell
node apps/cli/dist/index.js --setup-token $env:MEMLUME_SETUP_TOKEN setup adapter openclaw `
  --installation-id openclaw-desktop --project-id memlume `
  --brain-id '<project-brain-uuidv7>' --core-path $PWD --install-host --yes
node apps/cli/dist/index.js doctor
```

Adapter 設定只放 daemon URL、profile 與 token 參照；不會把 token 寫入 OpenClaw 的一般設定或 prompt。啟用 hook 後，OpenClaw 會在 task start 讀取 Context Pack、在明確 user message 後捕捉 memory、在 session end flush outbox；需要回報 usage/outcome 時，沿用該次 Context Pack 的 `traceId`。沒有 mount 的 OpenClaw 不能讀取該 Brain，也不能寫入它；直接 API 會回 `403 forbidden`，Adapter SDK 則 fail-open。

若要暫停共享腦，只需停止 daemon；OpenClaw 原生流程仍可執行，Adapter 會以空 context 繼續。
