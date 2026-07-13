# Shared Project Brain 範例

此範例展示同一台電腦上的 Hermes 與 Codex 共用一個 project Brain，且不碰任何 Agent native memory。

1. 建置並啟動 daemon，使用 setup token。
2. 建立一個 project Brain，分別註冊 Hermes（`read_write`）與 Codex（`read`）installation。
3. Hermes 收到「記住，這個專案使用 pnpm」後，Adapter 將 user event 捕捉到 project Brain；重送同一 `messageId` 不會產生第二份 memory。
4. Codex 在 task start 呼叫 `resolve_context`，從相同 project Brain 得到 `pnpm` 及 `sourceMemoryIds`。
5. 具 `read_write` mount 的 Adapter 可回報 memory usage/outcome；feedback 只影響下次排序，不改寫原始 event 或 memory history。
6. 未掛載的 OpenClaw 搜尋不到該 Brain；停止 daemon 時所有 Host 仍可使用自身 native capability。

建議驗收命令：

```text
pnpm test:e2e
pnpm benchmark:retrieval
node apps/cli/dist/index.js doctor
```

範例刻意不包含 token、真實資料庫或備份檔；請用 `setup adapter` 產生本機 profile。
