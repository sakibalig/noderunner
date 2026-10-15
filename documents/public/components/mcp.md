# `packages/mcp`

The MCP server that exposes the same ten tools to any MCP client, such as Claude Code or Cursor. It is the second
front door to [packages/tools](tools.md): it adds no tool logic of its own, and its single responsibility is to
register the permitted tools with the MCP SDK, bind every call to one server-chosen graph, and record each client
session as a `Run` so its steps appear in the web UI.

| Owner | Tasks | Layer | Depends on |
| --- | --- | --- | --- |
| Sakib | T18 | Surface (`src/server.ts`, `src/session.ts`), composition (`src/main.ts`) | `packages/core`, `packages/tools`, `packages/graph`; `@modelcontextprotocol/sdk`, `pino` |

## Responsibility

It owns the registration loop, the access filter, the graph binding from `MCP_GRAPH`, the stdio and Streamable HTTP
transports with the HTTP bearer check, the per-session `Run` and its call cap, the `tool.call.*` and `mcp.*` log
events, and its own composition root.

It does not own tool behaviour, Cypher, input validation, the `ToolResult` envelope, or `forModel`, all of which come
from `packages/tools`; and it never accepts a graph name, a run id, or an actor from a client. The model that drives
the calls is the client's, so the agent loop, its system prompt, and `validateReport` do not apply here.

## Interface

```ts
// packages/mcp/src/server.ts
export type Exposure = { readonly act: boolean };   // MCP_ALLOW_WRITES, parsed once in main.ts
export function createServer(deps: {
  readonly toolbox: Toolbox; readonly graph: GraphName; readonly exposure: Exposure;
  readonly sessions: Sessions; readonly log: Log;
}): McpServer;

// packages/mcp/src/session.ts
export class Sessions {
  constructor(deps: { readonly db: Db; readonly graph: GraphName; readonly clock: Clock; readonly ids: Ids });
  runFor(session: string): Promise<{ readonly runId: RunId; readonly calls: number }>; // Run made on first call
  close(session: string): Promise<void>;            // sets status "done" and finished_at
}

// packages/mcp/src/main.ts — composition root; reads env, builds adapters, picks the transport
```

The registration, adapted from the LLD's loop, with the dependencies injected rather than read from module scope:

```ts
const server = new Server({ name: "noderunner", version: CONTRACT_VERSION }, { capabilities: { tools: {} } });
const shown = tools.filter((d) => d.access !== "act" || deps.exposure.act);   // R5: read and derive always
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: shown.map((d) => ({ name: d.name, description: d.description, inputSchema: z.toJSONSchema(d.input) })),
}));
server.setRequestHandler(CallToolRequestSchema, async (req, extra) => {
  const def = shown.find((d) => d.name === req.params.name);
  if (!def) return unknownTool(req.params.name);   // a hidden act tool is unknown; nothing is written
  const session = await deps.sessions.runFor(extra.sessionId ?? STDIO_SESSION);
  if (session.calls >= limits.mcpCalls) return capped();
  const r = await deps.toolbox.callTool(def.name, req.params.arguments ?? {},
    { graph: deps.graph, runId: session.runId, actor: "mcp", signal: extra.signal }, stepHooks(deps.log));
  return { content: [{ type: "text", text: forModel(r) }], isError: !r.ok };
});
```

The handler is registered on the SDK's low-level `tools/list` and `tools/call` requests rather than through
`registerTool` with an `inputSchema`, because the high-level path validates the arguments before the handler runs,
and a malformed call would then never reach `callTool` and write no Step. Here the arguments go to `callTool`
unchanged; it creates the Step first and then validates the input itself
([contracts/mcp/tools.md](../../../contracts/mcp/tools.md#rules-every-tool-holds)), so a bad call from a client is
recorded like any other and answered with `isError: true` and the failing fields. `stepHooks` logs
`tool.call.started`, `tool.call.finished`, and `tool.call.failed`, since tools do not log (R17).

Named constants: `STDIO_SESSION = "stdio"`, `MAX_SESSIONS = 8` (HTTP), `SESSION_IDLE_MS = 1_800_000`; the call cap is
`limits.mcpCalls` (100) from core. Files: `src/main.ts`, `src/server.ts`, `src/session.ts`, `src/transport.ts`.

## Behaviour

### Start-up

1. `main.ts` parses the `mcp` pick of `packages/core/src/env.ts`: `FALKORDB_URL` and `MCP_GRAPH` are required,
   `MCP_ALLOW_WRITES` is exactly `true` or `false`, default `false`, and becomes `exposure.act`, `MCP_HTTP_PORT` is
   optional, and `MCP_TOKEN` is required when `MCP_HTTP_PORT` is set.
2. `MCP_GRAPH` must be a name `graphName` can produce, such as `repo:acme/api`, and must appear in `Db.list()`;
   otherwise the process exits with a message naming the variable and the graphs that exist.
3. It builds the toolbox with the planner's registry client, since `plan_upgrades` is a `derive` tool shown by
   default. With `exposure.act` it also builds the executor, which needs `GITHUB_TOKEN`; without it the executor
   port is an adapter that refuses with `invalid`, and `open_pull_request` is not shown anyway.
4. It picks the transport: stdio by default; Streamable HTTP on `MCP_HTTP_PORT` when it is set, bound to `127.0.0.1`
   and requiring `MCP_TOKEN` as a bearer token.
5. It logs `mcp.server.started` with the graph, whether `act` tools are shown, the transport, and the shown tool
   names, never the token.

### Access levels

Each tool's `access` in the [tool contract](../../../contracts/mcp/tools.md#access) is `read`, `derive`, or `act`
(R5). `read` and `derive` tools are always shown: `recall_decisions`, `list_alerts`, `reachability`,
`introduced_by`, `rank_packages`, `plan_upgrades`, `owners_for`, and `read_only_cypher`. The `act` tools,
`record_decision` and `open_pull_request`, are shown only with `MCP_ALLOW_WRITES=true`; otherwise a client can
neither list nor call them. So the default server answers "which alerts are reachable" through `reachability`
with no flag. Even with `act` shown, `open_pull_request` still refuses unless a human approved the plan through
`POST /plans/:id/approve`. Every call, of any access level, still writes its `Step` and `TOUCHED` edges under the
session's `Run`, because the trail is the product.

### Graph binding

The graph is fixed for the life of the process by `MCP_GRAPH`. No tool input has a graph field, the handler passes
`deps.graph` into `ToolCtx`, and `read_only_cypher` runs only on that graph. Serving another repository means
starting another process with another `MCP_GRAPH`.

### Sessions and runs

1. Over stdio there is one session per process; over HTTP, one per `Mcp-Session-Id`, at most `MAX_SESSIONS`.
2. On a session's first tool call, `Sessions.runFor` creates a `Run` with `agent: "mcp"`, `model: null`,
   `status: "running"`, and `started_at`, and logs `mcp.session.started` (R8). A client that connects and never
   calls leaves no `Run`.
3. Each call is a `Step` of that run, so the web app lists the run and its steps like any other, with evidence.
4. A session makes at most `limits.mcpCalls` (100) calls; the 15-call cap is for the worker's triage, fixer, and
   baseline runs only. The 101st call is answered with `isError: true` and "This session reached its 100-call
   limit; start a new session", writes no Step, and sets the run's status to `capped`, logged as `mcp.session.capped`.
5. When the HTTP session closes, after `SESSION_IDLE_MS` without a call, or when the stdio process exits,
   `Sessions.close` sets `status: "done"`, unless it is `capped`, and `finished_at`, and logs `mcp.session.closed`
   with the call count.
6. Calls in one session run one at a time, because tools write to the graph; a second concurrent call waits.

### Transports

Over stdio, standard output carries only the protocol: `pino` writes to standard error, and nothing else in the
process prints. The process is therefore started with `node` directly or with `pnpm --silent`, since a bare
`pnpm … start` prints its script banner on standard output and corrupts the stream. Over HTTP the server uses the
SDK's Streamable HTTP transport with session ids from `Ids`, and every request must carry
`Authorization: Bearer <MCP_TOKEN>`, compared in constant time; a missing or wrong token is answered 401 before any
session is created and logged as `mcp.request.rejected` without the header. Each request's `extra.signal` becomes
`ToolCtx.signal`, so a client that cancels a call aborts the tool.

### README snippet

```sh
claude mcp add noderunner -- pnpm --silent --filter @noderunner/mcp start
```

`FALKORDB_URL` and `MCP_GRAPH` come from the root `.env`, or are passed with `claude mcp add -e NAME=value`; the
command runs from the repository root. `node packages/mcp/dist/main.js` is the equivalent without pnpm.

### Demo moment

In Claude Code, connected to the demo repository's graph with the default, read-only settings, ask "which of my
alerts are actually reachable?". Claude Code chooses `reachability`, a `derive` tool shown by default, from the same
registry the triage agent uses, answers from the same tier query, and the web app shows a new run with agent `mcp`
whose step highlights the same paths. This is the Track 1 "tool selection through MCP" with no second
implementation.

## Failures

| Case | What the client sees |
| --- | --- |
| A tool returns `ToolErr` | `isError: true` and the `forModel` text naming the problem; the Step is stored |
| An `act` tool called without `MCP_ALLOW_WRITES=true` | An unknown-tool error; nothing is written |
| Input that fails the tool's schema | `isError: true` with each failing path; `callTool` stores the Step with `ok: false` |
| The 101st call in a session | `isError: true` naming the limit; no Step; the run is `capped` |
| HTTP request without the right `MCP_TOKEN` | 401; no session is created |
| `MCP_GRAPH` missing, malformed, or absent from FalkorDB; `MCP_HTTP_PORT` without `MCP_TOKEN` | The process exits at start-up with an actionable message |
| FalkorDB unreachable during a call | `isError: true` with an `upstream` message; retryable |
| Over `MAX_SESSIONS` HTTP sessions | The new session is refused; existing sessions continue |

Errors carry codes from [errors.json](../../../contracts/api/errors.json) in the log events `mcp.call.failed` and
`tool.call.failed`; no stack, path, or token reaches the client.

## Tests

FalkorDB is real with `fixtures/mini-repo` loaded; the client is the SDK's client over a linked in-memory transport,
so registration, schemas, and serialisation are real. GitHub and the sandbox are not reached.

- `list default`: without `MCP_ALLOW_WRITES` the client lists exactly the eight `read` and `derive` tools, including
  `reachability`.
- `list act`: with `MCP_ALLOW_WRITES=true` the client lists all ten.
- `call`: `reachability` on `fixtures/mini-repo` in the default mode returns text equal to `forModel` of the same
  result, and the graph holds one `Run` with agent `mcp` and one `Step` under it.
- `tool error`: `introduced_by` with an unknown key returns `isError: true`, and the `Step` has `ok: false`.
- `bad input`: `introduced_by` with `{ key: 7 }` returns `isError: true` naming `key`, and the graph holds one `Step`
  with `ok: false`.
- `hidden act`: calling `record_decision` by name in the default mode fails and no `Decision` or `Step` exists.
- `cap`: with the cap lowered to 3 for the test, the fourth call returns `isError: true`, three Steps exist, and the
  run is `capped`.
- `sessions`: two HTTP sessions create two runs; closing one sets its `status` to `done` and leaves the other running.
- `http auth`: an HTTP request with no token or a wrong one answers 401 and creates no session.
- `binding`: no advertised input schema contains a property that names a graph, and a process started with
  `MCP_GRAPH=repo:nobody/none` exits non-zero naming the variable.
- `stdio`: the server spawned with the README command's `pnpm --silent` writes standard output that parses as
  JSON-RPC from the first byte.

## Open points

Decisions are tracked in the [delivery plan](../../../nimbalyst-local/plans/noderunner.md#8-decisions).

- **Hosted HTTP.** The HTTP transport binds to `127.0.0.1`; serving it publicly from the hosted build is not planned,
  and would need its own host and rate limit on top of `MCP_TOKEN`.
