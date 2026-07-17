# Memlume Phase A 設計：Host 相容性與 Callback 穩定性

**目標：** 讓 Hermes directory plugin 能被真實 Host 載入，並讓所有主 Agent 的讀取 callback 在固定總時限內 fail-open，不因 outbox 或 daemon 異常拖慢對話。

## 範圍

本階段只處理 QA 報告的 Phase A：

1. Hermes loader-compatible directory entry。
2. `beforeTask` 讀取路徑與 outbox flush 解耦。
3. 500ms callback contract 與單一 deadline 行為。
4. slow daemon、hung outbox、offline 與真實 Hermes loader 驗證。

本階段不新增 document-project、`propose` ACL、revision workflow 或 vector search；那些屬於後續 Phase B～D。

## 設計

### Hermes 載入

Hermes v0.18.2 的 directory loader 會要求 adapter 根目錄同時存在 `plugin.yaml` 與 `__init__.py`，並從根 entry 匯入 `register(ctx)`。`adapters/hermes/__init__.py` 只負責轉出既有 `memlume_plugin.plugin.register`，不搬移或複製 plugin 實作。

### Callback deadline

`beforeTask` 先綁定 outbox，但不等待 flush；outbox retry 以背景工作執行。Context resolver 使用 250ms request budget，Host-facing callback 的總 contract 為 500ms，逾時回傳空 Context 並保留既有 fail-open 行為。這避免目前「500ms flush grace＋250ms context request」順序相加。

### 寫入與讀取

`onUserMessage` 維持明確 capture 的可靠寫入與 outbox retry；只有讀取 callback 不等待寫入。背景 flush 與前景 write 仍透過既有 outbox lock／serialize 保護，避免同一 JSONL outbox 被並行覆寫。

### 驗證

- Python loader smoke：若 `hermes_cli` 可用，使用 Hermes 的 `PluginManager` 載入乾淨 temporary plugin root，確認 manifest、`register` 與 hook 註冊；不可用時明確 skip，不把模擬 loader 當成真實通過。
- Node E2E：固定重現 hung outbox／context，確認 `beforeTask` 在 500ms 內回傳空 Context。
- 既有 Hermes、Codex、OpenClaw、Claude Code、完整 E2E、typecheck、build 與 benchmark 全部保留為 release gate。

## 失敗處理

- daemon 不可用或 context request 超時：回傳空 Context、記錄受限 diagnostics，不阻斷 Host。
- outbox lock／磁碟異常：背景 flush 保留 pending entry，下一次 callback 或明確寫入再重試。
- loader 缺少 Hermes runtime：測試標記 skipped；release workflow 若設定 `MEMLUME_REQUIRE_HERMES_SMOKE=1` 則必須 fail，而不是假裝支援。

