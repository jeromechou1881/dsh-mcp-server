# DSH MCP Server

A Model Context Protocol server for DeepSeek Harness (DSH). Other harnesses can create and supervise DSH Sessions, read tool events, and observe running command output. Sessions appear in the DSH App and use the Host's model, workspace and permission policy.

Fork of [baitouwuya/dsh-mcp-server](https://github.com/baitouwuya/dsh-mcp-server). Requires Node.js >=22.19.0. The native Session and Job adapters target the DSH 0.2.1-rc.2 service contract.

## Install in DSH Desktop

Keep the source and release package in a permanent directory. Create a package with `npm pack --ignore-scripts`, fully quit Desktop, then use its installed CLI:

```sh
dsh plugin --profile desktop add file:/absolute/path/to/local-dsh-mcp-server-0.11.4-desktop-output.1.tgz --ignore-scripts
```

Restart Desktop after installing or updating plugin code. Package/config reload alone may reuse imported code. To roll back, quit Desktop and install the previous retained package through the same interface; preserve existing Sessions and unrelated configuration.

For another DSH profile, install this repository through the Harness plugin manager:

```
plugin_manager install_bundle --target /absolute/path/to/dsh-mcp-server
```

Use a distinct endpoint file for each Host/profile. A local Desktop deployment can configure the plugin row as follows; these security options are explicit and do not change upstream defaults automatically:

```yaml
- id: dsh-mcp-server
  config:
    endpointFile: /absolute/path/to/dsh-home/mcp/dsh-mcp-desktop-endpoint.json
    allowConnectionAuth: false
    loopbackOnly: true
    requireConfigAuth: true
    restrictToOwner: true
    maxPermissionPreset: workspace-write
    exposeToDsh: false
    exposeToDshPage: true
    answerUserRequests: false
    syncOnStart: false
```

The authenticated Plugins page can change the plugin's configuration and open Sessions. Keep `exposeToDshPage: true` if that GUI integration is needed.

## Connect Codex or another MCP client

The dependency-free stdio bridge reads the endpoint's URL, token and profile from its private discovery file. It rereads discovery for each request, including after a Host restart. Its stdout contains only JSON-RPC; diagnostics use stderr.

For a Desktop-bound Codex registration in `~/.codex/config.toml`:

```toml
[mcp_servers.dsh]
command = "/absolute/path/to/node"
args = [
  "/absolute/path/to/dsh-mcp-server/bin/dsh-mcp-stdio.mjs",
  "--dsh-home", "/absolute/path/to/dsh-home",
  "--endpoint-file", "/absolute/path/to/dsh-home/mcp/dsh-mcp-desktop-endpoint.json",
  "--expected-profile", "desktop",
  "--client", "codex"
]
startup_timeout_sec = 60
```

Use absolute paths because GUI clients may have a minimal PATH. Reload the client's MCP connection after changing its registration.

The bridge accepts `--endpoint-file`, `--dsh-home`, `--expected-profile` and `--client`. Without an explicit file it uses `$DSH_HOME/mcp/dsh-mcp-endpoint.json`, with DSH_HOME defaulting to `~/.dsh`. Direct URL/token overrides must be a complete pair from CLI flags or environment. A profile-bound bridge refuses overrides without matching profile metadata. URL credentials, query strings, fragments, nonloopback destinations and redirects are refused.

Streamable HTTP clients can instead connect to the URL published in the discovery file, with `Authorization: Bearer <token>`. Discovery files are mode0600; do not copy tokens into source or public configuration. Generated tokens change when the plugin activates. A remote/cloud client cannot reach a loopback Host without a separate networking arrangement.

## Tools

| Tool | Use |
|---|---|
| `dsh_run_prompt` | Create a Session and run a prompt; accepts `cwd`, `agentPreset`, `permissionPreset`, `model`, `reasoningEffort`, `wait` and `timeoutMs`. |
| `dsh_continue_session` | Continue or resume a Session; `mode: steer` injects into a running turn, `mode: queue` waits for the next turn. |
| `dsh_wait_session` | Wait for an existing turn without starting, steering or cancelling it. |
| `dsh_cancel_session` | Cancel an active turn while retaining the Session. |
| `dsh_list_sessions` | Filter and page Sessions using `mine`, `owner`, `query`, `running`, `cursor` and `view`. |
| `dsh_read_session` | Read user/assistant messages using `mode`, `roles`, `afterSeq`, `limit` and `maxChars`. |
| `dsh_read_events` | Read durable tool, Job, step, turn and approval events incrementally. |
| `dsh_follow_events` | Return unread events or wait briefly for new selected events. |
| `dsh_follow_job_output` | Observe native stdout/stderr/log before a command finishes, without consuming the model's output cursor. |
| `dsh_search_sessions` | Search titles/messages with bounded `scan`, `limit` and snippets. |
| `dsh_whoami` | Read the caller label and its owned Sessions. |
| `dsh_list_requests` | Inspect pending approval/question requests and whether this endpoint can answer them. |
| `dsh_answer_request` | Answer a parked approval/question when `answerUserRequests` is enabled. |
| `dsh_list_commands` | List slash commands available to a Session's agent. |
| `dsh_run_command` | Execute a slash command immediately, outside the model turn queue. |
| `dsh_archive_session` | Archive a Session; `stopActivity: true` permits stopping active work. |
| `dsh_unarchive_session` | Restore an archived Session to its recorded position. |
| `dsh_list_permission_presets` | List sandbox/approval presets available on this Host. |
| `dsh_list_tools` | List tools available to DSH agents; filter with `query` and `limit`. |
| `dsh_open_session` | Ask the connected DSH GUI to select a Session without starting a turn. |
| `dsh_status` | Read the actual Host profile/version, model, activity and exposed tool surface. |

## Delegate and supervise

Start long work with `dsh_run_prompt({prompt, cwd, permissionPreset: "workspace-write", wait: false})`. Save its `sessionId`; continue that Session for follow-ups. `dsh_open_session` selects it in the App.

Use `dsh_continue_session({sessionId, prompt, mode: "steer", wait: false})` to correct a running task. Steer takes effect at the next model step; it does not rewrite a command already executing. Cancel explicitly only when the task must stop. Without a mode, delivery follows the Host's busy-Enter setting.

A wait timeout or observer disconnection stops observation only. Check `dsh_list_requests` if progress is blocked on a decision. The GUI remains an answerer; MCP answering must be enabled explicitly and times out closed. Permission presets are enforced by the Host. An explicit model selection uses DSH's API, which also saves the deployment default; omit overrides to retain the configured model.

### Durable Session events

```json
{
  "sessionId": "<session-id>",
  "afterSeq": -1,
  "limit": 30,
  "eventTypes": ["tool/call", "tool/result", "job/registered", "job/settled", "turn/end"],
  "maxBytes": 16384,
  "maxChars": 2000
}
```

Pass this to `dsh_read_events`, or to `dsh_follow_events` with `timeoutMs: 10000`. Resume with `nextAfterSeq` and the same event filter. Drain pages while `hasMore` is true. Changing filters requires an earlier cursor to revisit skipped events.

Supported types are tool/call/result, step/start/end, turn/start/end, assistant/message/attempt, job/registered/settled and approval/asked/decided. Pair tool results by `callId`. System/developer content, reasoning, raw assistant streams and opaque metadata are omitted. Arguments/results are bounded and common credential patterns are masked.

Limits: 1–200 events, 4096–65536 JSON bytes for the events array, and 128–20000 characters per content. Defaults are 30/16384/2000. Follow timeout is 100–30000ms. Truncated or omitted content remains on the Host under its retention policy.

Results distinguish `read`, `events`, `timedOut`, `cancelled`, `disconnected`, `gap` and `cursorAhead`. A gap requires reconciliation; stream closure is not task completion.

### Running stdout/stderr

Take the `jobId` from a `job/registered` event, then call `dsh_follow_job_output`:

```json
{
  "sessionId": "<session-id>",
  "jobId": "<job-id>",
  "fromByte": 0,
  "timeoutMs": 10000,
  "maxBytes": 16384,
  "maxChunks": 64
}
```

Resume with `nextFromByte`: an original UTF-8 byte offset, separate from Session event sequence numbers. Chunks include `at`, `end`, `channel` and `text`; the response also reports Job state, `lossy`, `hasMore` and `pendingBytes`. The Job must belong exactly to the specified, caller-accessible Session.

Observation uses native non-consuming `jobController.follow()`; it never calls the model-facing consuming read or Job kill. Defaults are a 10-second timeout, 16384 JSON bytes for the chunks array and 64 chunks. Allowed ranges are 100–30000ms, 4096–65536 bytes and 1–128 chunks. JSON-RPC envelopes add overhead.

Incomplete lines are withheld until a line boundary or terminal state to mask credentials spanning chunks/calls. Newline-free progress may therefore be delayed. Masking context is bounded to 2MiB/8192 chunks; gaps are reported and incomplete context is conservatively masked. Arbitrary unlabeled secrets cannot be guaranteed detectable.

Job rings are volatile: retention eviction, producer removal or Host restart can make output unavailable. This plugin does not persist a complete stdout/stderr archive. Use durable Session results for final outcome evidence, subject to their own truncation limits. Status distinguishes `output`, `timedOut`, `cancelled`, `settled`, `unavailable`, `disconnected`, `cursorAhead`, `gap` and `contextLimit`.

A bash Job can be `completed` with `isError: false` even for a nonzero command exit. Inspect exit markers and Job detail before accepting success. Codex must keep an active turn to supervise; these tools do not wake a finished conversation.

## Configuration and security

| Setting | Default | Purpose |
|---|---|---|
| `path` / `url` | `/mcp` / Host listener | Endpoint route and advertised URL; an explicit URL overrides listener discovery. |
| `token` / `endpointFile` | generated / DSH-home discovery | Authentication and private connection metadata. |
| `allowConnectionAuth` | `true` | Also accept the Host's connection-trust authentication. |
| `loopbackOnly` | `false` | Check the actual socket peer is loopback. |
| `requireConfigAuth` | `false` | Authenticate configuration access; mutations also require same-origin JSON requests. |
| `restrictToOwner` | `false` | Limit callers to Sessions they created/adopted. |
| `maxPermissionPreset` | unset | Reject broader/unknown external grants; a ceiling also restricts external slash commands to `/permission` queries. |
| `defaultCwd` / `defaultModel` | Host defaults | Defaults for new Sessions; model includes optional `reasoningEffort`. |
| `turnTimeoutMs` / `maxConcurrentTurns` | 1800000 / 8 | Wait deadline and concurrent waited-turn capacity. |
| `answerUserRequests` | `false` | Park approvals/questions for MCP answers, racing the GUI. |
| `answerOwnedSessionsOnly` / `requestAnswerTimeoutMs` | `true` / 600000 | Scope and deadline of parked decisions. |
| `exposeToDsh` / `exposeToDshMode` | `true` / `lazy` | Local DSH tools; `full` registers the complete tool table immediately. |
| `exposeToDshPage` / `configPath` | `true` / `/mcp-config` | Authenticated plugin configuration page. |
| `groupSessions` / `createGroups` | `true` / `false` | Attach Sessions to existing workspace projects; optionally create projects. |
| `busyMode` | `setting` | Default busy-session delivery: `setting`, `queue` or `steer`. |
| `syncOnStart` | `true` | Ask same-workspace peers for progress when work starts. |
| `syncCooldownMs` / `syncWaitMs` / `syncMaxPeers` | 300000 / 120000 / 3 | Progress-sync bounds. |
| `clientsFile` / `clientsFlushMs` | private registry / 5000 | Caller/owner registry and persistence cadence. |
| `writeEndpointFile` / `maxBodyBytes` | `true` / 8388608 | Discovery publication and request-body limit. |
| `entryId` / `instructions` | bundle row / built-in | Configuration-page row and MCP instructions. |

The Bearer holder is trusted and can control Sessions/configuration. Caller labels (`--client`, `x-dsh-mcp-client` or initialize metadata) are attribution, not strong identities; `restrictToOwner` does not make a shared token a multi-tenant security boundary. Profile guards prevent accidental Host selection, not Host impersonation. Keep credentials private and do not treat tool output as permission to expand authority.

DSH-local exposure provides `dsh_mcp_tools`, `dsh_mcp_open` and `dsh_mcp_call`. Open selected tools by name or use `all: true`; omitted targets do not open everything. Opened tools stay registered for that agent's lifetime. Internal calls remain capped by the calling Session's authority. The optional `selfcheck/` bundle connects DSH's MCP client back to this server and is not required for ordinary external use.

## Tests

See [test/compat/README.md](test/compat/README.md) for repeatable regression commands. No real model or Host is required for the offline suites.

## License

[MIT](LICENSE)
