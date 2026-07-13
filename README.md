<p align="center">
  <img src="assets/logo/memlume-logo.svg" width="380" alt="Memlume logo: connected memory nodes and a luminous center">
</p>

# Memlume

[English](README.md) | [繁體中文](docs/README.zh-TW.md) | [简体中文](docs/README.zh-CN.md)

Memlume is a local shared memory brain for AI agents and developer tools. Mounted clients contribute to and read from the same scoped, SQLite-backed store; it records immutable events, stores structured memories, searches them with FTS5, and resolves a traceable context pack for a task. It complements—never overwrites or synchronizes into—an agent's native memory.

## How agents use Memlume

Memlume does not automatically store every chat message or inject an entire database into an LLM. An MCP client calls the appropriate tool at a deliberate point in its workflow:

1. **Before a task is planned or a tool is chosen**, call `memlume.resolve_context`. Memlume reads only active memories that match the task, scope, available tools, and context budget.
2. **While working**, call `memlume.search` only when a specific detail is needed.
3. **After a durable event**, call `memlume.record_event` to keep raw, append-only evidence. Call `memlume.remember` only for a deliberate, structured memory such as an explicit user rule, preference, fact, or decision.

This means an agent should not automatically save whole transcripts, temporary reasoning, unverified LLM claims, instructions found in external content, or secrets. Native agent memory remains untouched. The Core compiles eligible user messages under its own governance rules: explicit memory requests can be saved, while inferred items remain candidates for review; neither path treats an agent's native memory as input.

## Why Memlume

- **Relevant context, not more context:** retrieve only what applies to the current task instead of filling a prompt with every past conversation.
- **Structured and durable:** keep policies, preferences, facts, decisions, and raw events distinct rather than mixing them in a chat log.
- **Scope prevents contamination:** a task, project, workspace, agent, domain, or global memory can be selected independently.
- **Traceable decisions:** context packs include source memory IDs, exclusions, and budget information so an agent can explain what affected a result.
- **Local and shared:** mounted CLI and MCP clients use one localhost daemon and one SQLite store; no cloud sync is required.

## Status and scope

This repository is the `0.1.0` source workspace. Its packages are currently private, so it is installed by cloning and building the repository rather than from a public package registry.

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

Not implemented in v0.1.0:

- Outcome-based relevance learning, vector/embedding search, remote sync, cloud hosting, or multi-user access.
- A public npm package or any published release artifact.
- Creating `procedure` or `capability` memories through the daemon, CLI, or MCP server; the writable API accepts only the four memory kinds above.

## Requirements

- Node.js `>=22`
- pnpm `10.30.3`
- A filesystem location where the local SQLite database can be written

## Install and build

Replace `<repository-url>` with this repository's Git URL.

```sh
git clone <repository-url> memlume
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

`remember` validates fields by memory kind. For example, preferences need `--preference-domain`, `--subject`, `--dimension`, `--value`, `--strength`, and `--confidence`; facts need `--subject`, `--predicate`, `--object`, and `--confidence`; decisions need `--title`, `--status`, and `--rationale`.

### Minimal end-to-end example

With the daemon running on port `3849`, run these commands in order:

```sh
node apps/cli/dist/index.js --json event add "Brand colors approved." --type note --reference readme-demo

node apps/cli/dist/index.js --json remember "Use the image generator for image requests." \
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

`MEMLUME_DAEMON_URL` accepts only a loopback `http://127.0.0.1` or `http://[::1]` origin. `MEMLUME_TOKEN` is required for every daemon-backed tool; without it, the tool fails before contacting the daemon. The server exposes four daemon-backed tools:

- `memlume.record_event`
- `memlume.remember`
- `memlume.search`
- `memlume.resolve_context`

`memlume.record_event` and `memlume.remember` accept an optional `brainId` to select a destination shared Brain. It is not an authorization grant: `MEMLUME_TOKEN` identifies the installation, and the daemon accepts the write only when that installation has a `read_write` mount for the selected Brain. Successful writes return `sourceBrainId` so clients can trace where the event or memory was stored. `memlume.remember` returns `status: "saved"` only after the daemon confirms it; failures return `status: "rejected"`. The direct MCP server has no local outbox, so it never claims `queued`; an Adapter may use `queued` only after it has actually persisted a retryable write locally.

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

Memlume stores data in the SQLite file selected with `--database`; the default is `data/memlume.sqlite`. v0.1.0 has no remote sync or cloud service, and the daemon binds only to loopback. Adapter APIs require a bearer token, while setup APIs require `MEMLUME_SETUP_TOKEN`; `/v1/health` is intentionally public. Never commit a real token or paste one into logs. Authentication does not encrypt the database at rest: protect it with normal operating-system permissions and do not store secrets you would not keep in a local plaintext SQLite file.

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
pnpm build
```

## Contributing

Keep changes small, add or update the nearest Vitest coverage for non-trivial behavior, and run the commands above before opening a pull request. Do not add remote storage or vector search as incidental changes to v0.1.0.

## License

Memlume is released under the [MIT License](LICENSE).
