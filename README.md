# Reqall OpenClaw Plugin

Persistent semantic project memory for [OpenClaw](https://openclaw.ai)
agents, backed by the [Reqall](https://reqall.net) MCP server: recall before
work, record agreed intent, persist outcomes before the agent finalizes.

The plugin is a native OpenClaw plugin (`openclaw.plugin.json`). It does not claim
the `memory` slot, so it runs alongside `memory-core` or any other memory plugin.

## Install

```bash
openclaw plugins install npm:@reqall/openclaw-plugin --accept-capabilities
# or from GitHub
openclaw plugins install git:github.com/ReqallSystem/openclaw_plugin --accept-capabilities

# Recall and the persist pass read the conversation, which OpenClaw gates for
# non-bundled plugins:
openclaw config set plugins.entries.reqall.hooks.allowConversationAccess true
```

Then connect the MCP server with one of the following.

**OAuth (default).** The plugin declares a `reqall` server
(`https://www.reqall.net/mcp`, `streamable-http`, `auth: "oauth"`). Sign in from
**Settings → MCP**, or run:

```bash
openclaw mcp login reqall
```

**API key.** Override the declared server and keep the key in the environment
(or `~/.openclaw/.env`):

```bash
export REQALL_API_KEY="rq_..."
openclaw mcp set reqall '{"url":"https://www.reqall.net/mcp","transport":"streamable-http","headers":{"Authorization":"Bearer ${REQALL_API_KEY}"}}'
openclaw mcp doctor reqall --probe
```

The plugin's own recall calls use `REQALL_API_KEY` (or a `reqall login` token)
from the Gateway environment. Without one, the plugin still binds the project and
reminds the agent, but cannot prefetch recall.

Check the install with `openclaw plugins inspect reqall --runtime`. It should
list the `before_prompt_build`, `after_tool_call`, `before_agent_finalize` and
`session_end` hooks with no "blocked" diagnostics. `openclaw skills list` should
show the seven `reqall-*` skills.

## How it behaves

| Hook | Behavior |
|---|---|
| `before_prompt_build` | Adds the Reqall policy as cacheable system context. For non-trivial prompts it also binds the project and prepends recall (`upsert_project` → `search` → open `list_records`) plus a `reqall-intend` reminder. Heartbeat and cron turns are skipped. |
| `after_tool_call` | Successful `write` / `edit` / `apply_patch` / mutating `exec` mark the turn as unpersisted; a Reqall `upsert_record` clears it. Read-only commands and git add/commit/push bookkeeping do not count. |
| `before_agent_finalize` | If the turn is unpersisted, requests **one** revision pass (`action: "revise"`, `maxAttempts: 1`) asking the agent to run `reqall-persist`. Harnesses without finalize support (e.g. Copilot) skip this. |
| `session_end` | Drops the session's in-memory state. |

Each session gets an opaque `openclaw:<sha256>` label (from `sessionKey`). The
agent is told to pass it as `session_id` on Reqall writes whose schema lists that
field. Recalled records are framed as background data, not instructions. Every
Reqall failure is fail-open.

## Configuration

`plugins.entries.reqall.config` in `~/.openclaw/openclaw.json`:

| Key | Default | Description |
|---|---|---|
| `autoContext` | `inject` | `inject` recall, `reminder` (binding only) or `off` |
| `autoPersist` | `revise` | `revise` or `off` |
| `contextLimit` / `openLimit` | `5` / `10` | Recall sizes |
| `projectName` | — | Fixed project; `REQALL_PROJECT_NAME` still wins |

Environment: `REQALL_API_KEY`, `REQALL_URL`, `REQALL_PROJECT_NAME`,
`REQALL_WORKSPACE_ROOT`, `REQALL_MACHINE_NAME`, `REQALL_AUTO_CONTEXT`,
`REQALL_AUTO_PERSIST`.

## Project identity

The project is resolved from the agent's workspace directory with the shared
[naming contract](https://github.com/ReqallSystem/plugins/blob/main/doc/PROJECT_NAMING.md)
(`lib/project-policy.mjs` is vendored byte-for-byte from `@reqall/core`):
`REQALL_PROJECT_NAME` → `projectName` setting → Git `origin` → a labelled
`project_name: …` in the prompt → `.reqall.yml` → package identity →
workspace-relative path → `.machine/<host>/<user>`. A personal assistant whose
workspace is `~/.openclaw/workspace` usually lands on the machine project;
set `projectName` to share memory with a repo.

## Skills

`reqall-context`, `reqall-intend`, `reqall-document`, `reqall-persist`,
`reqall-review`, `reqall-triage`, `reqall-sleep` (loaded from `./skills`).

## Development

```bash
npm test   # offline node --test + npm pack --dry-run
```

To try it in a throwaway OpenClaw home, run
`openclaw plugins install --link --accept-capabilities .` with `HOME` and
`OPENCLAW_STATE_DIR` pointed at a temporary directory.

## License

MIT
