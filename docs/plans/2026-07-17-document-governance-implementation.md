# Document Project 治理實作計畫

> 狀態：已完成（2026-07-17）。013 migration、proposal review/apply、drift/repair read gate、adapter routes、backup/CLI/docs 與 release gate 已通過。

> **必要子技能：** 使用 `superpowers:executing-plans` 依任務逐項實作本計畫。

**目標：** 在既有 Project Brain 的 Document Project 上加入 `read`／`propose`／`read_write` 治理閉環，讓提案可審核、可檢查 base revision、可原子套用回 Markdown authority，且 drift 或 repair 狀態不會進入搜尋與 Context。

**架構：** SQLite 只保存 proposal、audit、revision 狀態與可重建 projection；Markdown source root 仍是唯一 authority。`propose` 只能建立 pending proposal，`read_write` 才能 review/apply；apply 以同目錄暫存檔原子替換 source，成功同步後才標記 applied。每次 document read 先以 manifest hash reconcile，狀態不是 `ready` 時拒絕注入。

**技術：** Node.js 22、TypeScript、SQLite/better-sqlite3、Zod、Express、pnpm workspace、Vitest/Node test。

---

### 任務 1：ACL contract 與 migration

**檔案：**
- Modify: `packages/contracts/src/shared-brain.ts`
- Modify: `packages/contracts/src/memory.ts`
- Modify: `packages/shared-brains/src/brain-store.ts`
- Modify: `packages/shared-brains/src/brain-router.ts`
- Modify: `packages/shared-brains/src/project-binding-store.ts`
- Modify: `packages/context-resolver/src/read-set-planner.ts`
- Modify: `apps/daemon/src/routes.ts`
- Create: `packages/database/src/migrations/013_document_governance.ts`
- Modify: `packages/database/src/migrations/index.ts`
- Test: `packages/contracts/test/shared-brain.test.ts`
- Test: `packages/shared-brains/test/brain-store.test.mjs`
- Test: `packages/database/test/document-governance-migration.test.mjs`

**步驟：**

1. 先新增失敗測試：`BrainMountSchema` 接受 `propose`；`BrainStore.assertAccess` 允許 propose mount 讀取與提案，但拒絕 write；舊 `read`／`read_write` 仍通過。
2. 新增 migration `013_document_governance`：重建 `brain_mounts` 與 `workspace_projects` 的 access check，將 `document_projects` 加上 `state`，建立 `document_proposals` 與 `document_audit_events` 及必要 index/foreign key。
3. 更新 contract、BrainStore、router、ReadSet 與 project binding 的 access union；只有 `read_write` 仍視為 writable。
4. 執行 `pnpm --filter @memlume/database test`、`pnpm --filter @memlume/shared-brains test` 與 contracts tests，確認舊 migration 資料可升級。

### 任務 2：proposal store 與 revision conflict

**檔案：**
- Modify: `packages/shared-brains/src/document-project-store.ts`
- Modify: `packages/shared-brains/src/index.ts`
- Test: `packages/shared-brains/test/document-project-store.test.mjs`

**步驟：**

1. 先新增 proposal submit/review/apply 的失敗測試：錯誤 base revision 回 conflict；pending 不出現在 document search/context；propose access 可送出但不能 review/apply。
2. 新增 `DocumentProposal`、audit 型別與最小 store API：`propose`、`listProposals`、`reviewProposal`、`applyProposal`。
3. proposal 只保存完整 Markdown body、base revision/hash、reason/evidence 與 actor；review 只接受 pending，apply 只接受 approved；每個狀態變更寫 audit。
4. 以同目錄暫存檔與 rename 原子更新 source，成功 `sync` 後才標記 applied；任何同步失敗標記 `repair_required`，不允許半成品進 read model。

### 任務 3：source reconcile 與 read gate

**檔案：**
- Modify: `packages/shared-brains/src/document-project-store.ts`
- Modify: `apps/daemon/src/routes.ts`
- Test: `apps/daemon/test/document-governance.e2e.test.ts`

**步驟：**

1. 先新增 E2E：source 外部手改後，search/context 不回傳舊 section 並回報 drift；sync 後恢復 ready；repair_required 同樣拒絕讀取。
2. 實作 `reconcile`，比較 source manifest 與 active revision；讀取前自動 reconcile，僅 `ready` 且有 active revision 的 project 可搜尋或注入。
3. 新增 adapter-authenticated proposal/review/apply routes，所有 Brain UUID 先檢查 mount access；propose token 的 review/apply 固定 403。
4. 將 drift/conflict/state error 映射為可診斷的 409 response，保持一般 adapter fail-open。

### 任務 4：CLI、backup、文件與 release gate

**檔案：**
- Modify: `apps/cli/src/index.ts`
- Modify: `packages/backup/src/create-backup.ts`
- Modify: `packages/backup/src/import-brain.ts`
- Modify: `packages/backup/test/backup.test.mjs`
- Modify: `README.md`
- Modify: `docs/README.zh-TW.md`
- Modify: `docs/README.zh-CN.md`
- Modify: `docs/architecture/shared-brain.md`
- Modify: `CHANGELOG.md`

**步驟：**

1. CLI project binding 接受 `propose`，doctor/diagnostics 顯示該 access；預設 adapter setup 仍使用 read_write。
2. full backup 保留 proposal/audit/revision/state；selected Brain backup 只保留目標 Brain 的 document rows，避免跨 Brain 洩漏；restore 後 schema/hash/ACL 可驗證。
3. 更新三語 README、架構與 CHANGELOG，明確說明 proposal 是完整 body、apply 需 read_write、source drift 需 sync 修復。
4. 執行完整 `pnpm test`、`pnpm test:e2e`、`pnpm typecheck`、`pnpm build`、`pnpm benchmark:retrieval`，提交並推送 `main`。
