<p align="center">
  <img src="assets/logo/memlume-logo.svg" width="380" alt="Memlume logo: connected memory nodes and a luminous center">
</p>

# Memlume

[English](README.md) | [繁體中文](docs/README.zh-TW.md) | [简体中文](docs/README.zh-CN.md)

Memlume is a local external Shared Brain for AI agents and developer tools. On one computer, mounted clients use the same existing SQLite-backed store: it records immutable events, stores structured memories, searches them with FTS5, and resolves a traceable context pack for a task. It complements—never replaces, overwrites, or synchronizes into—an agent's native memory.

Public guides: [architecture](docs/architecture/shared-brain.md) · [Hermes](docs/guides/hermes.md) · [Codex](docs/guides/codex.md) · [OpenClaw](docs/guides/openclaw.md) · [Claude Code](docs/guides/claude-code.md) · [backup/restore](docs/guides/backup-restore.md) · [shared project example](examples/shared-project-brain/README.md).

## Shared Brain routing

Use Memlume for durable context that should survive switching among Hermes, Codex, OpenClaw, Claude Code, and direct MCP clients: project decisions, company conventions, personal preferences, or reviewed facts. It keeps those memories mountable, backup-friendly, and maintainable in one local SQLite database; each host's native memory remains its own.

The Adapter SDK has three shared callbacks:

| Callback | What it does |
| --- | --- |
| `beforeTask` | A main Agent reads mounted Context before work. Its default priority is **Project → Domain (Company) → Personal**; a caller may request only a smaller authorized subset. |
| `onUserMessage` | The only automatic capture entry point. Only an explicit memory request such as “remember” is compiled by Core; ordinary messages may be ignored. |
| `onSubagentStart` | A child Agent receives read-only Context from its configured Project Brain only. It never falls back to Domain or Personal, writes no memory, and does not flush the outbox. |

For a main Agent, a write target is selected in this order: an explicit Brain, then the profile's Project Brain, otherwise the write is rejected. Memlume never guesses a target or falls back to Personal. Brains—not hooks—are the data-ownership and permission boundary.

Queued explicit-memory captures are retried by the next `beforeTask` or `onUserMessage` call. The callback lifecycle does not retain complete transcripts, assistant output, temporary reasoning, or secrets.

### Host child-Agent support

| Host | Child Context behavior |
| --- | --- |
| Claude Code | Its `SubagentStart` hook directly injects restricted Project Brain Context. |
| Hermes | `subagent_start` only records the child; the child's first prompt receives restricted Context. |
| OpenClaw | `subagent_spawned` only records the child; the child's first prompt receives restricted Context. |
| Codex Plugin | No usable child-start hook is available today, so it does not automatically inject child Context. The SDK entry point is ready for a future official hook or external orchestration. |

## Direct MCP workflow

Memlume does not automatically store every chat message or inject an entire database into an LLM. An MCP client calls the appropriate tool at a deliberate point in its workflow:

1. **Before a task is planned or a tool is chosen**, call `memlume.resolve_context`. Memlume reads only active memories that match the task, scope, available tools, and context budget.
2. **While working**, call `memlume.search` only when a specific detail is needed.
3. **After a durable event**, call `memlume.record_event` to keep raw, append-only evidence. Call `memlume.remember` for a deliberate, structured memory; it creates a reviewable candidate so a prompt-injected agent cannot silently create an active policy. Approve it from the protected inbox when appropriate.

When reporting feedback, pass the `traceId` returned by `memlume.resolve_context` to `memlume.record_memory_usage` or `memlume.record_outcome`. A receipt is short-lived, limited per installation, accepts feedback only for memories included in that Context Pack, and accepts one task outcome. Across receipts, one installation can claim feedback for a given memory only once per 24-hour window. This keeps an adapter token from fabricating unlimited ranking signals.

This means an agent should not automatically save whole transcripts, assistant output, temporary reasoning, unverified LLM claims, instructions found in external content, or secrets. Native agent memory remains untouched. For Adapter capture, Core only compiles explicit memory requests under its own governance rules; ordinary messages may be ignored. Direct MCP writes remain deliberate calls and do not treat an agent's native memory as input.

## Why Memlume

- **Relevant context, not more context:** retrieve only what applies to the current task instead of filling a prompt with every past conversation.
- **Structured and durable:** keep policies, preferences, facts, decisions, and raw events distinct rather than mixing them in a chat log.
- **Scope prevents contamination:** a task, project, workspace, agent, domain, or global memory can be selected independently.
- **Traceable decisions:** context packs include source memory IDs, exclusions, and budget information so an agent can explain what affected a result.
- **Local and shared:** mounted clients use one localhost daemon and one SQLite store, which can be backed up and maintained without cloud sync.
- **Explainable feedback:** usage and task outcomes affect future ordering with fixed, inspectable score deltas; memory history stays immutable.

## Status and scope

This repository is the `0.2.0` source workspace. Its packages are currently private, so it is installed by cloning and building the repository rather than from a public package registry.

All functionality belongs to the MIT-licensed Memlume Core. The official website is only a download, installer, update, and documentation entry point; it does not provide a stronger closed edition.

Implemented:

- An append-only event journal and a local SQLite database.
- Structured `policy`, `preference`, `fact`, and `decision` memories.
- Global, domain, agent, workspace, project, and task scopes.
- SQLite FTS5 search and a deterministic context resolver with source memory IDs and a context budget.
- Shared brains with per-installation mounts, a localhost-only daemon, a CLI, and an MCP stdio server.
- Bearer-token authentication for adapter APIs; `/v1/health` remains a public local health check.
- Governed memory compilation, candidate review, and conflict-aware replacement.
- Verifiable local backups and restore maintenance, plus a local Shared Brain Console.
- Official local adapters for Hermes, Codex, OpenClaw, and Claude Code, all using the same mounted Brain rather than copying native agent memory.
- Outcome usage records, deterministic feedback ranking, retrieval benchmark, and reproducible backup/restore verification.
- Public architecture, adapter, backup, and shared-project guides; CI and tag-release workflows run the same checks as local development.

Not implemented in v0.2.0:

- Vector/embedding search, remote sync, cloud hosting, or multi-user access.
- A public npm package.
- Creating `procedure` or `capability` memories through the daemon, CLI, or MCP server; the writable API accepts only the four memory kinds above.

## Requirements

- Node.js `>=22`
- pnpm `10.30.3`
- A filesystem location where the local SQLite database can be written

## Install and build

```sh
git clone https://github.com/hi18aa/memlume.git memlume
cd memlume
pnpm install --frozen-lockfile
pnpm build
```

## Start the daemon

The daemon listens only on `127.0.0.1`. Create its default data directory:

```sh
mkdir -p data
```

```powershell
New-Item -ItemType Directory -Force data | Out-Null
```

Adapter APIs need a setup token and an adapter token. Generate a long random `MEMLUME_SETUP_TOKEN`, keep it out of source control, and start the daemon with it. The health endpoint remains public.

```sh
MEMLUME_SETUP_TOKEN='<long-random-secret>' pnpm --filter @memlume/daemon start -- --database ./data/memlume.sqlite --port 3849
```

```powershell
$env:MEMLUME_SETUP_TOKEN = '<long-random-secret>'
pnpm --filter @memlume/daemon start -- --database ./data/memlume.sqlite --port 3849
```

Prefer the protected `memlume setup adapter` command instead of manually copying an adapter token. It registers one local Agent installation, mounts its Project Brain with `read_write`, makes a loopback read smoke test, and keeps the token only in the current user's Memlume configuration. For example, the following also installs the Codex Plugin through its official marketplace flow:

```powershell
node apps/cli/dist/index.js --setup-token $env:MEMLUME_SETUP_TOKEN setup adapter codex `
  --installation-id codex-desktop --project-id memlume `
  --brain-id '<project-brain-uuidv7>' --core-path $PWD --install-host --yes
```

Use `hermes`, `openclaw`, or `claude-code` in place of `codex` for the other supported hosts. In a non-interactive shell, `--yes` is required before Memlume changes host Plugin configuration; an interactive terminal asks instead. Run the same command with `--install-host --dry-run` after the profile exists to preview non-secret host commands without changing the host. Codex and Claude Code still require the user to review and trust their hooks; Memlume never bypasses that platform control. `memlume doctor` lists local profiles and performs a read-only Context check without printing tokens.

`--database` defaults to `data/memlume.sqlite` and `--port` defaults to `3849`. Stop the process with `Ctrl+C`.

Check its health from another terminal:

```sh
curl http://127.0.0.1:3849/v1/health
# {"status":"ok"}
```

## CLI

The compiled CLI is `apps/cli/dist/index.js`. It defaults to `http://127.0.0.1:3849`; use `--url` before the command when the daemon uses another port. Every CLI command that calls the daemon needs an adapter token: set `MEMLUME_TOKEN` as above or pass `--token <adapter-token>` before the command. `--token` takes precedence. Global options such as `--url`, `--token`, and `--json` must appear before the command.

```sh
# Record an immutable event.
node apps/cli/dist/index.js --json event add "Brand colors approved." --type note --reference readme-demo

# Save a policy. A policy requires --intent, --action-type, and --action-target.
node apps/cli/dist/index.js --json remember "Use the image generator for image requests." \
  --kind policy --scope project --project readme-demo \
  --intent generate_image --action-type route_tool --action-target image_gen --required

# Search stored memories.
node apps/cli/dist/index.js --json search "image generator"

# Resolve a context pack for an intent and scope.
node apps/cli/dist/index.js --json context resolve \
  --intent generate_image --scope project --project readme-demo --budget 500
```

`remember` validates fields by memory kind. For example, preferences need `--preference-domain`, `--subject`, `--dimension`, `--value`, `--strength`, and `--confidence`; facts need `--subject`, `--predicate`, `--object`, and `--confidence`; decisions need `--title`, `--status`, and `--rationale`. When a supported Agent token calls this route without `--setup-token`, Core stores a candidate for review; supplying the setup token lets the CLI attach a user-confirmation signature for an explicitly typed command.

### Minimal end-to-end example

With the daemon running on port `3849`, run these commands in order:

```sh
node apps/cli/dist/index.js --json event add "Brand colors approved." --type note --reference readme-demo

node apps/cli/dist/index.js --setup-token "$MEMLUME_SETUP_TOKEN" --json remember "Use the image generator for image requests." \
  --kind policy --scope project --project readme-demo \
  --intent generate_image --action-type route_tool --action-target image_gen --required

node apps/cli/dist/index.js --json context resolve \
  --intent generate_image --scope project --project readme-demo --budget 500
```

The final JSON contains `context.directives` with the saved policy and `actionTarget: "image_gen"`. `--json` is useful for scripts because it prints the raw daemon response.

## MCP stdio server

Build first, keep the daemon running, then add an entry like this to your MCP client's stdio configuration. Replace `/absolute/path/to/memlume` with the absolute path to this checkout. On Windows, use a Windows absolute path in the `args` value.

```json
{
  "mcpServers": {
    "memlume": {
      "command": "node",
      "args": ["/absolute/path/to/memlume/apps/mcp-server/dist/index.js"],
      "env": {
        "MEMLUME_DAEMON_URL": "http://127.0.0.1:3849",
        "MEMLUME_TOKEN": "<adapter-token>"
      }
    }
  }
}
```

`MEMLUME_DAEMON_URL` accepts only a loopback `http://127.0.0.1` or `http://[::1]` origin. `MEMLUME_TOKEN` is required for every daemon-backed tool; without it, the tool fails before contacting the daemon. The server exposes six daemon-backed tools:

- `memlume.record_event`
- `memlume.remember`
- `memlume.search`
- `memlume.resolve_context`
- `memlume.record_memory_usage`
- `memlume.record_outcome`

`memlume.record_event` and `memlume.remember` accept an optional `brainId` to select a destination shared Brain. It is not an authorization grant: `MEMLUME_TOKEN` identifies the installation, and the daemon accepts the write only when that installation has a `read_write` mount for the selected Brain. `memlume.remember` returns `status: "candidate"` because structured writes require protected review; adapter capture of an explicit user message can still follow the Core compiler's explicit-user path. The direct MCP server has no local outbox, so it never claims `queued`; an Adapter may use `queued` only after it has actually persisted a retryable write locally. `record_memory_usage` and `record_outcome` are append-only feedback signals, not memory edits, and must use the `traceId` returned by `memlume.resolve_context`.

For example, an MCP client can call `memlume.resolve_context` with:

```json
{
  "intent": "generate_image",
  "scope": { "level": "project", "projectId": "readme-demo" },
  "task": "Create an image for the project README.",
  "contextBudget": 500,
  "available_tools": ["image_gen"]
}
```

MCP uses `available_tools` (snake case); the daemon receives it as `availableTools`.

## Privacy and local operation

Memlume stores data in the SQLite file selected with `--database`; the default is `data/memlume.sqlite`. v0.2.0 has no remote sync or cloud service, and the daemon binds only to loopback. Adapter APIs require a bearer token, while setup APIs require `MEMLUME_SETUP_TOKEN`; `/v1/health` is intentionally public. Never commit a real token or paste one into logs. Authentication does not encrypt the database at rest: protect it with normal operating-system permissions and do not store secrets you would not keep in a local plaintext SQLite file.

## Architecture

```text
CLI ───────────┐
               ├─> localhost daemon (127.0.0.1) ─> SQLite + FTS5
MCP stdio ─────┘               │
                               ├─> append-only event journal
                               ├─> structured memory store
                               └─> context resolver
```

The CLI and MCP server do not open SQLite themselves; they send requests to the daemon. The resolver returns a context pack with directives, preferences, facts, decisions, source memory IDs, exclusions, and context-budget information where applicable.

## Test

```sh
pnpm typecheck
pnpm test
pnpm test:e2e
pnpm build
pnpm benchmark:retrieval
```

## Contributing

Keep changes small, add or update the nearest Vitest coverage for non-trivial behavior, and run the commands above before opening a pull request. Do not add remote storage or vector search as incidental changes to v0.2.0.

## License

Memlume is released under the [MIT License](LICENSE).
