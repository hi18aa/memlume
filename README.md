<p align="center">
  <img src="assets/logo/memlume-logo.svg" width="380" alt="Memlume logo: connected memory nodes and a luminous center">
</p>

# Memlume

[English](README.md) | [繁體中文](docs/README.zh-TW.md) | [简体中文](docs/README.zh-CN.md)

Memlume is a local external Shared Brain for AI agents and developer tools. On one computer, Hermes, Codex, OpenClaw, Claude Code, MCP clients, and future adapters can use the same Brain. Markdown records are the human-readable authority; SQLite is the searchable projection. Memlume records immutable events, stores structured memories, searches them with FTS5, and resolves a traceable context pack for a task. It complements—never replaces, overwrites, or synchronizes into—an agent's native memory.

Public guides: [architecture](docs/architecture/shared-brain.md) · [Hermes](docs/guides/hermes.md) · [Codex](docs/guides/codex.md) · [OpenClaw](docs/guides/openclaw.md) · [Claude Code](docs/guides/claude-code.md) · [backup/restore](docs/guides/backup-restore.md) · [shared project example](examples/shared-project-brain/README.md).

## Why use Memlume?

AI tools usually keep separate memories. That works until you switch from Codex to Hermes, open a different project, or need to recover a decision months later. Memlume is the shared, local layer that keeps durable context in the right place and gives each Agent only what the current task needs.

| Situation | What Memlume solves |
| --- | --- |
| You switch between Hermes, Codex, OpenClaw, Claude Code, and MCP | One Personal Brain and the relevant Project Brain are available to every mounted host on the same computer. |
| You work on several projects | Each project has its own Project Brain; a company, team, or organization can simply be represented as a Project. |
| You want memory without prompt clutter | `beforeTask` reads a bounded, task-relevant ReadSet instead of injecting the whole database. |
| You do not want to say “save this to Memlume” every time | Host hooks send the lifecycle event; Core filters, classifies, routes, and decides whether it is worth storing. |
| You need to trust or correct what was remembered | Explicit user statements can become `active`; inferences stay `candidate`; conflicts, approvals, and corrections remain auditable. |
| You need local ownership and recovery | Markdown is human-readable authority, SQLite is rebuildable search projection, and backups stay on the local machine. |

The user-facing model is intentionally small: **Personal Brain** for durable personal preferences and identity, plus one or more **Project Brains** for projects, products, companies, or teams. Hooks are timing adapters—not separate brains—and native Agent memory remains untouched.

## Shared Brain routing

Use Memlume for durable context that should survive switching among Hermes, Codex, OpenClaw, Claude Code, and direct MCP clients: project decisions, company conventions, personal preferences, or reviewed facts. It keeps those memories mountable, backup-friendly, and maintainable in one local data root: Markdown records are authoritative, while SQLite/FTS5 provides the rebuildable search projection. Each host's native memory remains its own.

The Adapter SDK has three shared callbacks:

| Callback | What it does |
| --- | --- |
| `beforeTask` | The daemon plans a workspace ReadSet and injects only relevant active Context before work. A host does not choose Brain UUIDs. |
| `onUserMessage` | Memlume's single automatic capture entry point. It filters secrets, splits mixed statements, routes each atom to Personal or the workspace Project Brain, and puts unknown projects in the durable Inbox. |
| `onSubagentStart` | A child Agent receives a restricted read-only ReadSet. It cannot widen the parent grant, write memory, or flush the outbox. |

Capture governance: eligible, non-sensitive user messages are appended as immutable events. Normal statements can become reviewable `candidate` memories; an explicit request such as “remember” can take the `active` path, still subject to conflict review. Blank or unsupported events are ignored, and sensitive content is redacted or rejected.

For v0.3 automatic capture, the host sends workspace and session identity, not a Brain UUID. The daemon owns Brain routing and permissions. An explicit v0.2 Brain target remains supported for compatibility, but automatic mode never guesses a target or silently falls back from an unknown Project to Personal. Brains—not hooks—are the data-ownership and permission boundary.

The local outbox accepts explicit-memory captures only; queued captures are retried by the next `beforeTask` or `onUserMessage` call. The callback lifecycle does not retain complete transcripts, assistant output, temporary reasoning, or secrets.

## When Memlume writes and reads

Memlume is useful when the same durable fact must survive a host switch without copying one host's private memory into another:

1. **Before a task:** `beforeTask` sends the workspace path, task text, entities, and intent. Core resolves a deterministic ReadSet (Primary Project, task-matched Linked Projects, and relevant Personal memory) and returns only active, budget-fitting context.
2. **When the user sends a message:** `onUserMessage` sends the message after local validation. Greetings, small talk, secrets, and unsupported transcript text are ignored or rejected. Explicit requests such as “remember that I use Vue” can become active after conflict checks; ordinary inferred statements remain candidates.
3. **When a project is unclear:** the atom is written to `inbox/pending` as `routing_required`. It is never guessed into another Brain. A maintainer can route it later with an explicit Brain and audit trail.
4. **After an assistant final:** adapters may place only the bounded final answer in a 24-hour runtime buffer. A short user approval such as “可以”, “同意”, or “修正：…” authorizes that text through the normal capture pipeline; the approval word itself is never stored as the memory.

This is why users do not need to say “save this to Memlume” every time. The hook supplies the event; the Core decides whether it is worth storing, where it belongs, and whether it is safe to read back.

### Host child-Agent support

| Host | Child Context behavior |
| --- | --- |
| Claude Code | Its `SubagentStart` hook directly injects restricted Project Brain Context through official `additionalContext`. |
| Hermes | `subagent_start` observes and registers the child; its first supported `pre_llm_call` prompt receives restricted Context. |
| OpenClaw | `subagent_spawned` observes and registers the child; its first supported `before_prompt_build` prompt receives restricted Context. |
| Codex Plugin | Official [`SubagentStart`](https://learn.chatgpt.com/docs/hooks#subagentstart) directly injects restricted Project Brain Context through `additionalContext`. |

## Direct MCP workflow

Memlume does not automatically store every chat message or inject an entire database into an LLM. An MCP client calls the appropriate tool at a deliberate point in its workflow:

1. **Before a task is planned or a tool is chosen**, call `memlume.resolve_context`. Memlume reads only active memories that match the task, scope, available tools, and context budget.
2. **While working**, call `memlume.search` only when a specific detail is needed.
3. **After a durable event**, call `memlume.record_event` to keep raw, append-only evidence. Call `memlume.remember` for a deliberate, structured memory; it creates a reviewable candidate so a prompt-injected agent cannot silently create an active policy. Approve it from the protected inbox when appropriate.

When reporting feedback, pass the `traceId` returned by `memlume.resolve_context` to `memlume.record_memory_usage` or `memlume.record_outcome`. A receipt is short-lived, limited per installation, accepts feedback only for memories included in that Context Pack, and accepts one task outcome. Across receipts, one installation can claim feedback for a given memory only once per 24-hour window. This keeps an adapter token from fabricating unlimited ranking signals.

This means an agent should not automatically save whole transcripts, assistant output, temporary reasoning, unverified LLM claims, instructions found in external content, or secrets. Native agent memory remains untouched. Direct MCP writes remain deliberate calls and do not treat an agent's native memory as input.

## Why Memlume

- **Relevant context, not more context:** retrieve only what applies to the current task instead of filling a prompt with every past conversation.
- **Structured and durable:** keep policies, preferences, facts, decisions, and raw events distinct rather than mixing them in a chat log.
- **Scope prevents contamination:** Personal and Project memories remain separate; task and workspace constraints narrow what can be read for the current turn.
- **Traceable decisions:** context packs include source memory IDs, exclusions, and budget information so an agent can explain what affected a result.
- **Local and shared:** mounted clients use one localhost daemon and one local data root; Markdown remains the authority and SQLite is a rebuildable search projection that can be backed up without cloud sync.
- **Explainable feedback:** usage and task outcomes affect future ordering with fixed, inspectable score deltas; memory history stays immutable.

## Status and scope

This repository is the `0.3.0` source workspace. Its packages are currently private, so it is installed by cloning and building the repository rather than from a public package registry.

All functionality belongs to the MIT-licensed Memlume Core. The official website is only a download, installer, update, and documentation entry point; it does not provide a stronger closed edition.

Implemented:

- An append-only event journal, Markdown authority records, durable routing Inbox, and a local SQLite projection.
- Structured `policy`, `preference`, `fact`, and `decision` memories.
- Personal and Project Brains with workspace bindings, plus task-level ReadSet constraints.
- SQLite FTS5 search and a deterministic context resolver with source memory IDs and a context budget.
- Governed document projects on existing Project Brains: Markdown authority, revision/hash/section citations, FTS search, bounded attachments, proposal review, atomic apply, audit, and drift protection.
- Workspace initialization and explicit Project bindings, server-planned ReadSets, per-installation mounts, a localhost-only daemon, a CLI, and an MCP stdio server.
- Bearer-token authentication for adapter APIs; `/v1/health` remains a public local health check.
- Governed memory compilation, candidate review, conflict-aware replacement, secret filtering, and approval of bounded assistant finals.
- Verifiable local backups and restore maintenance, including Markdown-first v3 bundles, plus a local Shared Brain Console.
- Official local adapters for Hermes, Codex, OpenClaw, and Claude Code, all using the same mounted Brain rather than copying native agent memory.
- Outcome usage records, deterministic feedback ranking, retrieval benchmark, and reproducible backup/restore verification.
- Public architecture, adapter, backup, and shared-project guides; CI and tag-release workflows run the same checks as local development.

Not implemented in v0.3.0:

- Vector/embedding search, remote sync, cloud hosting, or multi-user access.
- A public npm package.
- Creating `procedure` or `capability` memories through the daemon, CLI, or MCP server; the writable API accepts only the four memory kinds above.

### Governed document projects

A Project Brain can optionally point at a Markdown source root. The source files remain the only authority; an explicit sync creates immutable revision snapshots and searchable sections in SQLite. SQLite stores a rebuildable projection plus proposals, revision state, and audit events—it is not the document authority. Profile attachments decide whether an authorized host receives `always_core`, `task_conditional`, or `explicit_only` sections. Ordinary chat capture never writes to a document project, and a document attachment never bypasses the Brain mount.

Document writes use three mount permissions:

- `read` can search and receive active sections.
- `propose` can submit a complete Markdown body with a base revision/hash, reason, and evidence. It creates `pending` only; it cannot review or apply.
- `read_write` can approve/reject and apply a proposal. Apply rechecks the base revision, atomically replaces the Markdown file, syncs a new revision, and records an audit event.

Every document search and Context resolution reconciles the source manifest first. A hand edit sets the project to `drift`; an apply failure sets `repair_required`. Neither state returns stale SQLite sections. Run an explicit sync after correcting the source. Proposal routes are `/v1/documents/proposals`, `/review`, and `/apply` and require an adapter bearer token.

The current MVP is daemon API based:

```sh
# setup endpoints require MEMLUME_SETUP_TOKEN
curl -X POST "$MEMLUME_DAEMON_URL/v1/setup/document-projects/$BRAIN_ID" \
  -H "x-memlume-setup-token: $MEMLUME_SETUP_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"sourceRoot":"/absolute/path/to/docs"}'
curl -X POST "$MEMLUME_DAEMON_URL/v1/setup/document-projects/$BRAIN_ID/sync" \
  -H "x-memlume-setup-token: $MEMLUME_SETUP_TOKEN" -H 'content-type: application/json' -d '{}'
curl "$MEMLUME_DAEMON_URL/v1/documents/search?q=deployment" \
  -H "authorization: Bearer $MEMLUME_TOKEN"
```

To propose a document update, use the `revisionId` and `sourceSha256` returned by the setup document listing. The proposal body is the complete replacement Markdown, not a patch:

```sh
curl -X POST "$MEMLUME_DAEMON_URL/v1/documents/proposals" \
  -H "authorization: Bearer $MEMLUME_TOKEN" -H 'content-type: application/json' \
  -d '{"brainId":"'$BRAIN_ID'","logicalPath":"architecture.md","baseRevisionId":"'$REVISION_ID'","baseSourceSha256":"'$SOURCE_SHA256'","proposedBody":"# Architecture\n\nUpdated.","reason":"Approved architecture change."}'
```

Use the setup API to mount the Project Brain and create a profile binding before expecting automatic document Context. Search and Context responses include the logical path, heading path, revision ID, and source SHA-256 citation.

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

Prefer the protected `memlume setup adapter` command instead of manually copying an adapter token. In v0.3, omit `--project-id` and `--brain-id` to use workspace-owned routing; pass `--workspace-path` to initialize and mount that workspace's Project Brain. The command mounts the Personal Brain, makes a loopback read smoke test, and keeps the token only in the current user's Memlume configuration. For example, the following also installs the Codex Plugin through its official marketplace flow:

```powershell
node apps/cli/dist/index.js --setup-token $env:MEMLUME_SETUP_TOKEN setup adapter codex `
  --installation-id codex-desktop --workspace-path $PWD --core-path $PWD --install-host --yes
```

Use `hermes`, `openclaw`, or `claude-code` in place of `codex` for the other supported hosts. In a non-interactive shell, `--yes` is required before Memlume changes host Plugin configuration; an interactive terminal asks instead. Run the same command with `--install-host --dry-run` after the profile exists to preview non-secret host commands without changing the host. Codex and Claude Code still require the user to review and trust their hooks; Memlume never bypasses that platform control. `memlume doctor` lists local profiles and performs a read-only Context check without printing tokens.

`--database` defaults to `data/memlume.sqlite` and `--port` defaults to `3849`. Stop the process with `Ctrl+C`.

Check its health from another terminal:

```sh
curl http://127.0.0.1:3849/v1/health
# {"status":"ok","service":"memlume"}
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

`memlume.record_event` and `memlume.remember` accept an optional `brainId` to select a destination shared Brain. It is not an authorization grant: `MEMLUME_TOKEN` identifies the installation, and the daemon accepts the write when that installation has a `read_write` mount for the selected Brain. `memlume.remember` returns `status: "candidate"` because structured writes require protected review; adapter capture of an explicit user message can still follow the Core compiler's explicit-user path. The direct MCP server has no local outbox, so it never claims `queued`; an Adapter may use `queued` after it has actually persisted a retryable write locally. `record_memory_usage` and `record_outcome` are append-only feedback signals, not memory edits, and must use the `traceId` returned by `memlume.resolve_context`.

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

Memlume stores Markdown authority records and the SQLite projection beneath the data root selected with `--database`; the default is `data/memlume.sqlite`. v0.3.0 has no remote sync or cloud service, and the daemon binds only to loopback. Adapter APIs require a bearer token, while setup APIs require `MEMLUME_SETUP_TOKEN`; `/v1/health` is intentionally public. Runtime buffers are short-lived and excluded from the Brain and backups. Never commit a real token or paste one into logs. Authentication does not encrypt the database at rest: protect it with normal operating-system permissions and do not store secrets you would not keep in a local plaintext SQLite file.

## Architecture

```text
CLI ───────────┐
               ├─> localhost daemon (127.0.0.1)
MCP stdio ─────┘               │
Adapters/hooks ────────────────┤
                               ├─> Markdown authority + routing Inbox
                               ├─> SQLite projection + FTS5
                               ├─> Brain Router + ReadSet Planner
                               └─> context resolver / receipts
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

Keep changes small, add or update the nearest Vitest coverage for non-trivial behavior, and run the commands above before opening a pull request. Do not add remote storage or vector search as incidental changes to v0.3.0.

## License

Memlume is released under the [MIT License](LICENSE).
