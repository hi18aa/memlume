# Codex Adapter

Codex Adapter 由 `adapters/codex/hooks/memlume.mjs` 呼叫共用 Adapter SDK，並以官方 Plugin Marketplace manifest 提供安裝入口。

```powershell
node apps/cli/dist/index.js --setup-token $env:MEMLUME_SETUP_TOKEN setup adapter codex `
  --installation-id codex-desktop --project-id memlume `
  --brain-id '<project-brain-uuidv7>' --core-path $PWD --install-host --yes
```

`--install-host --dry-run` 可預覽不含 token 的 marketplace/hook 命令。Codex 仍會要求使用者信任 hook；Memlume 不會代替 Codex 放寬信任。

Codex 在任務開始前讀取 project/domain/personal Brain 的排序 Context Pack，工作中可使用 MCP `memlume.search`，並以 Context Pack 的 `traceId` 回報 usage/outcome。Codex 的 native memory 不會搬到 Memlume；未掛載時 daemon 直接 endpoint 會回 `403 forbidden`，Adapter SDK 才會為了 fail-open 轉成空 Context Pack。
