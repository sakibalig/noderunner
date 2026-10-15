# Contracts

Versioned agreements that more than one party must honour. **Nothing here is importable code.** Each file fixes a
shape that crosses a process boundary, a team boundary, or the boundary to the model, so that the graph half and the
agent and UI half of the team — and any MCP client a judge connects — build against one written authority instead
of whichever implementation happened to land first.

| File | Agreement between | Fixes |
| --- | --- | --- |
| [`graph/schema.md`](graph/schema.md) | ingestion, the tools, the executor, the UI, and `read_only_cypher` callers | graph names, node labels, keys, properties, relationship types, indexes, and what survives a re-ingest |
| [`api/worker.md`](api/worker.md) | the web app and the worker | every Run API route, its body, its response, authentication, and limits |
| [`api/events.md`](api/events.md) | the worker, the web app, and the stored run | the server-sent event stream and the `RunEvent` union |
| [`api/errors.json`](api/errors.json) | every surface | stable error code to HTTP status to retryability |
| [`mcp/tools.md`](mcp/tools.md) | the tools, the agent loop, the MCP server, and the model | the ten tool names, their inputs and outputs, the `ToolResult` envelope, and which tools write |
| [`version`](version) | all of the above | the contract version these files describe |

Changing any file here is a contract change: bump `version`, update the zod schemas in `packages/core` and every
consumer in the same change, and have the other owner review it.

**What does not belong here.** A shape that only one package reads is not a contract; it is a type, and it lives
in the package that owns it. The zod schemas in `packages/core` are the executable form of these documents. Where a
document and a schema disagree, the disagreement is a bug, and the document is the authority until the owners
decide otherwise.
