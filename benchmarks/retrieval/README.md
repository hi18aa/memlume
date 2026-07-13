# Retrieval Benchmark

這組可重跑 benchmark 驗證 Memlume Core 的 FTS5 與 Context Resolver：英文與繁體中文查詢、跨 Brain、時間有效性、同範圍衝突優先序，以及未授權 Brain 的隔離。

執行：

```text
pnpm benchmark:retrieval
```

輸出包含 `precisionAt3`、`missRate`、Context token units（目前以可解釋的文字單位計算）與 `p95LatencyMs`。門檻刻意保守：precision@3 ≥ 0.25、miss rate ≤ 0.25、p95 ≤ 1000 ms；未達門檻時命令會以失敗結束。

資料集位於 [cases.jsonl](./cases.jsonl)。目前 FTS5 已滿足門檻，因此不引入向量索引或 reranker；若未來資料量或語言分布使門檻失敗，必須先以新的 benchmark 結果提出替代方案。
