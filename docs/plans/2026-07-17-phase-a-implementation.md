# Phase A Host 相容性與 Callback 穩定性 Implementation Plan

> **Required sub-skill:** Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 修正 Hermes directory plugin 載入與 adapter callback timeout，讓 `main`／release gate 能可靠驗證 Host fail-open 行為。

**Architecture:** Hermes 根 entry 只轉出既有 `register`；Adapter SDK 將 `beforeTask` 的 outbox retry 改成不阻塞讀取的背景工作，context request 保持短 timeout 並由 Host callback contract 限制總時長。真實 Hermes loader smoke 與 Node E2E 共同驗證，不以放寬 timeout 取代根因修正。

**Tech Stack:** Python `unittest`、Hermes v0.18.2 loader、TypeScript、Vitest、Node test、pnpm、GitHub Actions。

---

### Task 1: Reproduce the current failures

**Files:**
- Test: `test/e2e/adapter-contract.test.ts`
- Test: `adapters/hermes/tests/test_plugin.py`

**Step 1: Run the failing E2E contract test**

Run: `pnpm --filter @memlume/adapter-sdk build; pnpm --filter @memlume/daemon build; pnpm --filter @memlume/daemon exec vitest --root ../.. run test/e2e/adapter-contract.test.ts`

Expected: the hung outbox test fails because the callback exceeds the 500ms contract.

**Step 2: Run the Hermes plugin tests**

Run: `python -m unittest discover -s adapters/hermes/tests -p test_*.py`

Expected: existing unit tests pass, demonstrating that the missing root loader entry is not currently covered.

---

### Task 2: Add Hermes loader entry and regression coverage

**Files:**
- Create: `adapters/hermes/__init__.py`
- Test: `adapters/hermes/tests/test_plugin.py`
- Test: `adapters/hermes/tests/test_loader.py`

**Step 1: Write the failing loader test**

Assert the adapter root contains `plugin.yaml` and `__init__.py`, and that the root module exports the same callable `register` as `memlume_plugin.plugin`.

**Step 2: Run the loader test to verify it fails**

Run: `python -m unittest adapters.hermes.tests.test_loader`

Expected: fail because `adapters/hermes/__init__.py` is missing.

**Step 3: Implement the minimal root entry**

Create a root module that imports and exports `register` from `.memlume_plugin.plugin` without duplicating plugin behavior.

**Step 4: Run the loader test and Hermes unit tests**

Run: `python -m unittest adapters.hermes.tests.test_loader; python -m unittest discover -s adapters/hermes/tests -p test_*.py`

Expected: all tests pass; optional real Hermes loader test runs when the Hermes runtime is installed.

---

### Task 3: Decouple beforeTask outbox retry from context read

**Files:**
- Modify: `packages/adapter-sdk/src/index.ts`
- Test: `test/e2e/adapter-contract.test.ts`
- Test: `packages/adapter-sdk/test/adapter-client.test.mjs`

**Step 1: Add a focused regression assertion**

Use a pending outbox and a never-resolving fetch; assert `beforeTask` returns the empty Context within 500ms and does not wait for the retry.

**Step 2: Run the focused test to verify it fails**

Run: `pnpm --filter @memlume/adapter-sdk build; pnpm --filter @memlume/daemon build; pnpm --filter @memlume/daemon exec vitest --root ../.. run test/e2e/adapter-contract.test.ts -t "hung outbox"`

Expected: fail with `Expected callback within 500ms.`.

**Step 3: Implement the minimal decoupling**

Bind the outbox, schedule a serialized bounded flush without awaiting it, and immediately execute the context request. Preserve outbox locking, warnings, retry status, and the existing 250ms context request timeout.

**Step 4: Run focused adapter tests**

Run: `pnpm --filter @memlume/adapter-sdk test; pnpm --filter @memlume/daemon exec vitest --root ../.. run test/e2e/adapter-contract.test.ts`

Expected: the timeout regression and all existing outbox tests pass.

---

### Task 4: Verify host callback budgets and real-loader behavior

**Files:**
- Modify: `adapters/hermes/memlume_plugin/plugin.py`
- Modify: `adapters/openclaw/src/runtime.mjs`
- Test: `adapters/hermes/tests/test_loader.py`
- Test: `adapters/openclaw/test/adapter.test.mjs`
- Modify: `.github/workflows/ci.yml`
- Modify: `.github/workflows/release.yml`

**Step 1: Add budget assertions**

Assert Hermes and OpenClaw read hooks advertise the same 500ms callback budget and remain fail-open when the SDK returns no context.

**Step 2: Implement only contract-alignment changes**

Use one shared documented constant per host; do not increase the budget to mask a slow SDK path. Make the real Hermes smoke command explicit and environment-gated.

**Step 3: Run host tests**

Run: `pnpm test:hermes; pnpm test:openclaw; pnpm test:codex; pnpm test:claude-code`

Expected: all adapter suites pass.

---

### Task 5: Run the complete release gate and commit

**Files:**
- Verify: all changed files and GitHub workflow definitions.

**Step 1: Run full local gate**

Run: `pnpm test; pnpm test:e2e; pnpm typecheck; pnpm build; pnpm benchmark:retrieval`

Expected: exit code 0 with no failed tests.

**Step 2: Check formatting and staged diff**

Run: `git diff --check; git status --short`

Expected: no whitespace errors and only intended Phase A changes.

**Step 3: Commit**

```bash
git add adapters/hermes packages/adapter-sdk test/e2e adapters/openclaw .github/workflows docs/plans
git commit -m "fix: stabilize host adapter callbacks"
```

**Step 4: Push and inspect CI**

Run: `git push origin main; gh run list --repo hi18aa/memlume --limit 3`

Expected: the new main verification run completes successfully before claiming Phase A complete.

