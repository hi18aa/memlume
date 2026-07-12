<p align="center">
  <img src="assets/logo/memlume-logo.svg" width="380" alt="Memlume logo: connected memory nodes and a luminous center">
</p>

# Memlume

[English](README.md) | [繁體中文](docs/README.zh-TW.md) | [简体中文](docs/README.zh-CN.md)

Memlume is a local, structured-memory service for AI agents and developer tools. It records immutable events, stores scoped memories, searches them with SQLite FTS5, and resolves a traceable context pack for a specific task.

## Status and scope

This repository is the `0.1.0` source workspace. Its packages are currently private, so it is installed by cloning and building the repository rather than from a public package registry.

Implemented:

- An append-only event journal and a local SQLite database.
- Structured `policy`, `preference`, `fact`, and `decision` memories.
- Global, domain, agent, workspace, project, and task scopes.
- SQLite FTS5 search and a deterministic context resolver with source memory IDs and a context budget.
- A localhost-only daemon, a CLI, and an MCP stdio server that both call the daemon.

Not implemented in v0.1.0:

- Outcome tracking, conflict handling, a memory compiler, a web Console, vector/embedding search, remote sync, cloud hosting, or multi-user access.
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

Then leave this command running in a separate terminal:

```sh
pnpm --filter @memlume/daemon start -- --database ./data/memlume.sqlite --port 3849
```

`--database` defaults to `data/memlume.sqlite` and `--port` defaults to `3849`. Stop the process with `Ctrl+C`.

Check its health from another terminal:

```sh
curl http://127.0.0.1:3849/v1/health
# {"status":"ok"}
```

## CLI

The compiled CLI is `apps/cli/dist/index.js`. It defaults to `http://127.0.0.1:3849`; use `--url` before the command when the daemon uses another port. Global options such as `--url` and `--json` must appear before the command.

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
        "MEMLUME_DAEMON_URL": "http://127.0.0.1:3849"
      }
    }
  }
}
```

`MEMLUME_DAEMON_URL` accepts only a loopback `http://127.0.0.1` or `http://[::1]` origin. The server exposes four daemon-backed tools:

- `memlume.record_event`
- `memlume.remember`
- `memlume.search`
- `memlume.resolve_context`

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

Memlume stores data in the SQLite file selected with `--database`; the default is `data/memlume.sqlite`. v0.1.0 has no remote sync or cloud service, and the daemon binds only to loopback. That prevents network exposure, but it does not protect the database from other local processes that can read its path. There is no authentication or encryption at rest, so protect the database with normal operating-system permissions and do not store secrets you would not keep in a local plaintext SQLite file.

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

Keep changes small, add or update the nearest Vitest coverage for non-trivial behavior, and run the commands above before opening a pull request. Do not add remote storage, vector search, or a Console as incidental changes to v0.1.0.

## License

Memlume is released under the [MIT License](LICENSE).
