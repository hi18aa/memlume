# Memlume Phase B 設計：Document Project Read-only MVP

## 目標

在既有 `kind=project` Brain 上增加可選的 document-project capability：以使用者指定的 Markdown source root 為唯一 authority，將文件版本與章節投影到 SQLite/FTS，並依已授權的 profile attachment 產生有預算、可引用的 Context。一般對話 capture 不進入此流程。

## 邊界

- 不新增 Brain kind；document project 只掛在 project Brain。
- 不提供文件寫回、proposal、review、apply 或自動 capture；那些屬於 Phase C。
- source root 只讀掃描；SQLite 保存 immutable snapshot 供 citation 與重建，不能反向覆蓋 source。
- mount 仍是第一層 ACL；profile attachment 只定義讀取策略，不授予額外權限。

## 資料模型

```text
document_projects       Brain 的 source root、authority/capture/retrieval policy、active revision
document_revisions      一次掃描的 manifest hash 與狀態
documents               logical path 與目前 active version
document_versions       source hash、Markdown snapshot、frontmatter、heading index
document_sections       章節文字、heading path、priority、estimated text units
document_section_search FTS5 可重建搜尋 projection
profile_document_bindings  installation 對 project Brain 的 always_core/task_conditional/explicit_only attachment
```

## 讀取流程

1. setup token 設定 project Brain 的 source root，明確執行 sync。
2. scanner 只接受 UTF-8 `.md` regular files，拒絕 root、目錄或檔案 symlink。
3. sync 在單一 transaction 建立 revision、document version 與 section projection；成功後才切換 active revision。
4. adapter 的 `/v1/context/resolve` 先依既有 memory ReadSet 解析，再以 installation 的 mounted project attachments 解析文件 sections。
5. `always_core` 讀指定文件（未指定時依 priority 讀取），`task_conditional` 依 task/intent 搜尋，`explicit_only` 只有明確 path 才讀取。
6. 文件與 memory 共用 context budget；每段回傳 `documentId`、`sectionId`、`logicalPath`、`headingPath`、`revisionId`、`sourceSha256`。

## API

- `POST /v1/setup/document-projects/:brainId`：設定或更新 source root。
- `POST /v1/setup/document-projects/:brainId/sync`：顯式掃描與投影。
- `GET /v1/setup/document-projects/:brainId/documents`：查看目前 active/missing 文件。
- `POST /v1/setup/installations/:agentInstallationId/document-bindings`：設定 profile attachment。
- `GET /v1/documents/search`：adapter 以已 mounted Brain 搜尋 active sections。
- `/v1/context/resolve`：自動附加已授權 profile document context。

## 不變量

- 未 mounted 的 Brain 永遠不能透過 document API 讀取。
- `capture_mode` 固定為 `manual_only`；一般 capture route 不建立文件資料列。
- rejected/missing/superseded version 不進搜尋或 Context。
- source hash、revision 與 citation 必須能回溯到原始 logical path。
