# Hermes Adapter

Hermes Adapter 使用 `adapters/hermes/bridge.mjs` 與 Python plugin 將 Hermes lifecycle 轉成 Memlume Core 的共用 Adapter SDK。

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

每次任務前讀取 Context Pack；使用者明確的「記住」訊息經 `/v1/memories/capture` 寫入；需要回報 usage/outcome 時，使用同一次 Context Pack 的 `traceId`。暫時離線時，安全且不含秘密的寫入會進入 installation-specific outbox，恢復後重送。Hermes 原生記憶仍由 Hermes 自己管理。

## 檢查

```powershell
node apps/cli/dist/index.js doctor
```

看到 `read: ok` 且 `write: ok` 才代表 mount 與 token 可用。只要 Shared Brain 不可用，Hermes 仍可使用自身原生功能。
