# Memlume Phase B 實作計畫：Document Project Read-only MVP

> 狀態：已完成（2026-07-17）。本計畫只涵蓋唯讀 MVP；ACL proposal、drift/reconcile 與文件治理保留至 Phase C。

## Task 1：資料表與 contracts

- [x] 新增 `document-project` contracts 與 ContextPack 的 document section 欄位。
- [x] 新增 migration `012_document_projects`，建立 project/revision/document/version/section/FTS/profile binding tables。
- [x] 補 migration 與 schema regression tests。

## Task 2：source scanner 與 projection

- [x] 在 `@memlume/shared-brains` 新增 `DocumentProjectStore`。
- [x] 驗證 absolute source root、拒絕 symlink、只讀 UTF-8 Markdown。
- [x] 解析簡單 frontmatter 與 heading sections；依 source hash 建立 immutable version。
- [x] transaction 完成後才切 active revision；SQLite 僅作 projection/snapshot。

## Task 3：daemon setup/read API

- [x] 接入 `createDaemon` 與 `DaemonServices`。
- [x] 新增 setup configure/sync/list 與 profile binding endpoint。
- [x] 新增 adapter-authenticated document search。
- [x] 所有 document read 先檢查 Brain mount，attachment 不得繞過 mount。

## Task 4：context integration

- [x] profile attachment 支援 `always_core`、`task_conditional`、`explicit_only`。
- [x] 文件 sections 與既有 memory 共用 bounded context budget。
- [x] ContextPack 與四個 adapter renderer 顯示 path/heading/text citation。
- [x] 一般 capture 不觸碰 document tables。

## Task 5：驗證與交付

- [x] unit：scanner、frontmatter、hash、section split、FTS、budget、symlink/ACL。
- [x] integration：setup → sync → mount → attachment → context/search。
- [x] `pnpm test`（workspace 測試以單一併發驗證）、`pnpm test:e2e`、typecheck、build、benchmark。
- [x] 更新 guides/README，提交並推送 `main`。
