# TypeScript Project References Implementation Plan

> **Required sub-skill:** Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 讓 `pnpm typecheck` 從乾淨 checkout 即可成功，並由 TypeScript 7 Project References 管理所有 Node workspace package 的 declaration 與建置順序。

**Architecture:** 新增 root solution `tsconfig.json`，將四個 leaf projects 接到完整的 direct-reference graph；各 Node project 啟用 `composite` 並將 `.tsbuildinfo` 放入自己的 `dist`。root 與 filtered package commands 都改用 `tsc -b --stopBuildOnErrors`，CI 在任何 test/build 之前驗證無既有產物並執行 typecheck。

**Tech Stack:** TypeScript 7.0.2（Go native compiler）、pnpm workspace、TypeScript Project References、GitHub Actions、Vite/Vue（維持既有獨立 build）。

---

### Task 1: Reproduce and preserve the clean-workspace failure

**Files:**
- Inspect: `package.json`
- Inspect: `apps/cli/package.json`
- Inspect: `packages/backup/package.json`
- Inspect: `apps/cli/src/index.ts`

**Step 1: Start from a clean implementation worktree**

Use a new worktree or confirm the current implementation worktree has no `apps/*/dist`, `packages/*/dist` or `*.tsbuildinfo`. Do not delete another developer's build artifacts merely to manufacture this state.

Run:

```powershell
pnpm install --frozen-lockfile
Get-ChildItem apps/*/dist,packages/*/dist -ErrorAction SilentlyContinue
Get-ChildItem apps/*/*.tsbuildinfo,packages/*/*.tsbuildinfo -ErrorAction SilentlyContinue
```

Expected: installation succeeds and both artifact listings are empty.

**Step 2: Run the current root typecheck**

Run:

```powershell
pnpm typecheck
```

Expected before implementation: FAIL with `TS2307` at `apps/cli/src/index.ts`, stating that `@memlume/backup` or its declarations cannot be found.

**Step 3: Confirm the failure is ordering, not a source error**

Run each command separately:

```powershell
pnpm --filter @memlume/backup build
pnpm --filter @memlume/cli typecheck
```

Expected: both pass, proving that pre-existing backup output masks the root failure.

No commit for this task; it establishes the red regression state required by @superpowers:test-driven-development.

---

### Task 2: Define the TypeScript project graph

**Files:**
- Create: `tsconfig.json`
- Modify: `apps/cli/tsconfig.json`
- Modify: `apps/daemon/tsconfig.json`
- Modify: `apps/mcp-server/tsconfig.json`
- Modify: `packages/adapter-sdk/tsconfig.json`
- Modify: `packages/backup/tsconfig.json`
- Modify: `packages/context-resolver/tsconfig.json`
- Modify: `packages/contracts/tsconfig.json`
- Modify: `packages/database/tsconfig.json`
- Modify: `packages/event-journal/tsconfig.json`
- Modify: `packages/memory-compiler/tsconfig.json`
- Modify: `packages/retrieval/tsconfig.json`
- Modify: `packages/shared-brains/tsconfig.json`
- Do not modify: `apps/console/tsconfig.json`

**Step 1: Add the root solution config**

Create `tsconfig.json` with only the leaf projects:

```json
{
  "files": [],
  "references": [
    { "path": "./apps/cli" },
    { "path": "./apps/daemon" },
    { "path": "./apps/mcp-server" },
    { "path": "./packages/adapter-sdk" }
  ]
}
```

**Step 2: Make every Node TypeScript project composite**

In each listed project config, preserve the existing options and add these exact compiler options:

```json
"composite": true,
"tsBuildInfoFile": "dist/tsconfig.tsbuildinfo"
```

Keep the existing `declaration: true`, `rootDir: "src"`, `outDir: "dist"` and `include: ["src"]`. Do not place `composite` in `tsconfig.base.json`, because `apps/console` also extends it and is intentionally outside this declaration graph.

**Step 3: Add exact direct references**

Add these top-level `references` arrays:

| Consumer config | Exact references |
|---|---|
| `apps/cli/tsconfig.json` | `[{ "path": "../../packages/backup" }]` |
| `apps/mcp-server/tsconfig.json` | `[{ "path": "../../packages/contracts" }]` |
| `packages/adapter-sdk/tsconfig.json` | `[{ "path": "../contracts" }]` |
| `packages/backup/tsconfig.json` | `[{ "path": "../contracts" }, { "path": "../database" }]` |
| `packages/context-resolver/tsconfig.json` | `[{ "path": "../contracts" }, { "path": "../retrieval" }]` |
| `packages/event-journal/tsconfig.json` | `[{ "path": "../contracts" }, { "path": "../database" }]` |
| `packages/memory-compiler/tsconfig.json` | `[{ "path": "../contracts" }]` |
| `packages/retrieval/tsconfig.json` | `[{ "path": "../contracts" }, { "path": "../database" }, { "path": "../shared-brains" }]` |
| `packages/shared-brains/tsconfig.json` | `[{ "path": "../contracts" }, { "path": "../database" }]` |
| `apps/daemon/tsconfig.json` | backup, contracts, context-resolver, database, event-journal, memory-compiler, retrieval、shared-brains under `../../packages/*` |

Use this complete daemon array:

```json
"references": [
  { "path": "../../packages/backup" },
  { "path": "../../packages/contracts" },
  { "path": "../../packages/context-resolver" },
  { "path": "../../packages/database" },
  { "path": "../../packages/event-journal" },
  { "path": "../../packages/memory-compiler" },
  { "path": "../../packages/retrieval" },
  { "path": "../../packages/shared-brains" }
]
```

`packages/contracts` and `packages/database` have no workspace TypeScript dependencies, so they need `composite` but no `references` property.

**Step 4: Ask TypeScript to validate the graph before script migration**

Run:

```powershell
pnpm exec tsc -b --clean
pnpm exec tsc -b --stopBuildOnErrors --verbose
```

Expected: TypeScript lists dependencies before consumers, exits 0, and creates `dist/index.d.ts` plus `dist/tsconfig.tsbuildinfo` for the referenced projects.

**Step 5: Commit the project graph**

```powershell
git add tsconfig.json apps/cli/tsconfig.json apps/daemon/tsconfig.json apps/mcp-server/tsconfig.json packages/*/tsconfig.json
git commit -m "build: define TypeScript project graph"
```

---

### Task 3: Make workspace scripts use build mode

**Files:**
- Modify: `package.json`
- Modify: `apps/cli/package.json`
- Modify: `apps/daemon/package.json`
- Modify: `apps/mcp-server/package.json`
- Modify: `packages/adapter-sdk/package.json`
- Modify: `packages/backup/package.json`
- Modify: `packages/context-resolver/package.json`
- Modify: `packages/contracts/package.json`
- Modify: `packages/database/package.json`
- Modify: `packages/event-journal/package.json`
- Modify: `packages/memory-compiler/package.json`
- Modify: `packages/retrieval/package.json`
- Modify: `packages/shared-brains/package.json`

**Step 1: Replace the root compiler orchestration**

Set the root scripts to:

```json
"build": "pnpm --filter @memlume/console build && tsc -b --stopBuildOnErrors",
"typecheck": "tsc -b --stopBuildOnErrors"
```

Do not change the existing test, adapter or benchmark scripts in this step.

**Step 2: Replace package compiler scripts**

For every Node TypeScript package listed above, set:

```json
"build": "tsc -b --stopBuildOnErrors",
"typecheck": "tsc -b --stopBuildOnErrors"
```

Apply these intentional exceptions:

- `apps/daemon` build remains `pnpm run build:console && tsc -b --stopBuildOnErrors`.
- Remove `build:dependencies` from `apps/daemon` and `apps/mcp-server`.
- Do not add compiler scripts to `apps/console`.

**Step 3: Make tests call their own self-contained build**

Set these scripts exactly:

```text
// apps/cli/package.json
"test": "pnpm run build && vitest run --pool=threads"

// apps/mcp-server/package.json
"test": "pnpm run build && vitest run"

// packages/context-resolver/package.json
"test": "pnpm run build && vitest run"

// packages/event-journal/package.json
"test": "pnpm run build && vitest run"

// packages/retrieval/package.json
"test": "pnpm run build && vitest run"
```

Keep existing `pnpm run build && ...` tests in adapter-sdk, backup, database, memory-compiler, shared-brains and daemon. Contracts has no workspace dependency and may keep `vitest run`.

**Step 4: Verify root and filtered commands from a clean graph**

Run each command separately:

```powershell
pnpm exec tsc -b --clean
pnpm typecheck
pnpm exec tsc -b --clean
pnpm --filter @memlume/cli typecheck
pnpm --filter @memlume/cli test
```

Expected: all commands exit 0; filtered CLI typecheck builds backup, database and contracts without a prior root build.

**Step 5: Commit the script migration**

```powershell
git add package.json apps/*/package.json packages/*/package.json
git commit -m "build: use TypeScript build mode"
```

---

### Task 4: Add the clean-workspace CI regression and developer documentation

**Files:**
- Modify: `.github/workflows/ci.yml`
- Modify: `.github/workflows/release.yml`
- Modify: `README.md`
- Modify: `docs/README.zh-TW.md`
- Modify: `docs/README.zh-CN.md`

**Step 1: Move typecheck before every masking command**

In both workflows, immediately after `pnpm install --frozen-lockfile`, insert the artifact assertion and typecheck. Use this exact GitHub Actions fragment:

```yaml
      - name: Verify clean TypeScript workspace
        shell: bash
        run: |
          artifacts="$(find apps packages -mindepth 2 -maxdepth 2 \( -type d -name dist -o -type f -name '*.tsbuildinfo' \) -print)"
          if [[ -n "$artifacts" ]]; then
            printf 'Unexpected pre-existing TypeScript build artifacts:\n%s\n' "$artifacts"
            exit 1
          fi
      - run: pnpm typecheck
      - name: Verify project-reference outputs
        shell: bash
        run: |
          test -f packages/backup/dist/index.d.ts
          test -f packages/backup/dist/tsconfig.tsbuildinfo
          test -f apps/cli/dist/index.js
```

Remove the old later `pnpm typecheck` step. Keep test, E2E, build and benchmark after this regression.

**Step 2: Document the new command semantics in all README languages**

Add one sentence next to the development verification commands.

English:

```markdown
`pnpm typecheck` uses TypeScript Project References and may create `dist/` and `.tsbuildinfo` artifacts. Run `pnpm exec tsc -b --clean` to remove them.
```

Traditional Chinese:

```markdown
`pnpm typecheck` 使用 TypeScript Project References，會視需要產生 `dist/` 與 `.tsbuildinfo`；可執行 `pnpm exec tsc -b --clean` 移除這些產物。
```

Simplified Chinese:

```markdown
`pnpm typecheck` 使用 TypeScript Project References，会按需生成 `dist/` 与 `.tsbuildinfo`；可运行 `pnpm exec tsc -b --clean` 删除这些产物。
```

**Step 3: Verify workflow ordering and documentation consistency**

Run:

```powershell
rg -n "Verify clean TypeScript workspace|pnpm typecheck|pnpm test|pnpm build" .github/workflows/ci.yml .github/workflows/release.yml
rg -n "Project References|tsc -b --clean" README.md docs/README.zh-TW.md docs/README.zh-CN.md
```

Expected: each workflow contains exactly one `pnpm typecheck`, placed before test/build; all three READMEs describe the same behavior.

**Step 4: Commit the regression gate and docs**

```powershell
git add .github/workflows/ci.yml .github/workflows/release.yml README.md docs/README.zh-TW.md docs/README.zh-CN.md
git commit -m "ci: typecheck clean workspaces first"
```

---

### Task 5: Run clean and full release verification

**Files:**
- Verify: all changed files
- Reference: `docs/plans/2026-07-18-typescript-project-references-design.md`

Use @superpowers:verification-before-completion before claiming this bug fixed.

**Step 1: Prove the exact clean-workspace contract**

Run each command separately:

```powershell
pnpm exec tsc -b --clean
Get-ChildItem apps/*/dist,packages/*/dist -ErrorAction SilentlyContinue
Get-ChildItem apps/*/*.tsbuildinfo,packages/*/*.tsbuildinfo -ErrorAction SilentlyContinue
pnpm typecheck
Test-Path packages/backup/dist/index.d.ts
Test-Path packages/backup/dist/tsconfig.tsbuildinfo
Test-Path apps/cli/dist/index.js
```

Expected: both pre-typecheck listings are empty; `pnpm typecheck` exits 0; all three `Test-Path` calls return `True`.

**Step 2: Verify incremental behavior**

Run:

```powershell
pnpm typecheck
```

Expected: exits 0 without rebuilding unchanged projects. Use `pnpm exec tsc -b --dry` if confirmation is needed; do not add performance thresholds.

**Step 3: Run the complete local release gate**

Run each command separately:

```powershell
pnpm test
pnpm test:e2e
pnpm typecheck
pnpm build
pnpm benchmark:retrieval
```

Expected: every command exits 0 with no failed test or type error.

**Step 4: Inspect the final diff**

Run:

```powershell
git diff --check HEAD~3
git status --short
git log -3 --oneline
```

Expected: no whitespace errors; only intended files are changed; the three implementation commits are present. Preserve the unrelated untracked `docs/QA/` directory.

**Step 5: Push only when explicitly authorized**

Do not create a release or push from the planning phase. When authorized, push the implementation branch and confirm the first CI steps are clean-workspace assertion followed by typecheck, before relying on later green tests.

---

## Explicitly skipped

- No `paths` aliases to source: they would bypass the package declaration boundary being tested.
- No Nx, Turborepo, Wireit or custom dependency graph validator: `tsc -b` already owns this graph.
- No composite config for `apps/console`: current root typecheck never covered it, and TypeScript 7.0 still has compiler-API limitations for Vue tooling.
- No declaration maps, separate test projects or parallelism tuning: add only after a measured development need.
