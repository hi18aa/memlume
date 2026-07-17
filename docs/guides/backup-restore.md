# 備份與還原

完整 `.memlume` 備份包含 schema、Brain、mount、event、memory、memory history、document revision/proposal/audit、usage/outcome 與 checksum；bundle 不包含明文 adapter token。單一 Brain export 適合跨專案移動，但含 Document Project 的 Brain 必須使用完整 backup/restore，避免遺漏 Markdown governance 狀態。

## 什麼時候使用哪種備份

- **日常保護**：使用完整 backup，保留 Personal Brain、所有 Project Brain、mount 與稽核資料，可在原機還原。
- **分享或搬移單一內容**：匯出沒有 Document Project 的單一 Project Brain；公司、團隊或產品若以 Project 管理，也可單獨搬移。含 document project、proposal 或 audit 的 Brain 請用完整 backup。
- **災難復原**：優先使用 Markdown-first v3 bundle；Markdown authority 與 Routing Inbox 可重建 SQLite projection，不必把暫存 runtime、token 或 outbox 當成 Brain 資料備份。

備份解決的是「好維護、好搬移、好復原」，不是遠端同步；目前資料仍由本機使用者掌握。

```powershell
$env:MEMLUME_BACKUP_PASSWORD = '<long-random-password>'
node apps/cli/dist/index.js --setup-token $env:MEMLUME_SETUP_TOKEN backup create `
  --output .\data\memlume-full.memlume --password-env MEMLUME_BACKUP_PASSWORD
node apps/cli/dist/index.js backup verify .\data\memlume-full.memlume --password-env MEMLUME_BACKUP_PASSWORD
node apps/cli/dist/index.js --setup-token $env:MEMLUME_SETUP_TOKEN backup restore `
  .\data\memlume-full.memlume --password-env MEMLUME_BACKUP_PASSWORD --yes
```

還原前請停止會寫入同一資料庫的程序；CLI 會先驗證 manifest、scope、checksum 與密碼。還原後重新執行 `memlume doctor`，確認 migration、integrity、mount、`read`／`propose`／`read_write` ACL，以及 proposal/revision/audit 狀態。備份檔與密碼都應留在本機安全位置，不要提交 GitHub。
