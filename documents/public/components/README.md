# Components

One low-level design per package. Each follows the same shape — responsibility, interface, behaviour, failures,
tests, and open points — and defers to the [contracts](../../../contracts) for every shape that crosses a package or
team boundary.

| Component | Package | Owner | Tasks |
| --- | --- | --- | --- |
| [core](core.md) | `packages/core` | Sakib | T02 |
| [graph](graph.md) | `packages/graph` | Shaukat | T03, T11 |
| [ingest](ingest.md) | `packages/ingest` | Shaukat (stages 1–4, 6), Sakib (stage 5) | T04–T08, T19 |
| [tools](tools.md) | `packages/tools` | Shaukat | T12, T13 |
| [planner](planner.md) | `packages/planner` | Shaukat | T14 |
| [llm](llm.md) | `packages/core` port, `apps/worker/src/adapters/model` | Sakib | T16 |
| [agent](agent.md) | `apps/worker/src/agent` | Sakib (triage loop), Shaukat (fixer) | T16, T27 |
| [worker](worker.md) | `apps/worker` | Sakib | T09, T15 |
| [mcp](mcp.md) | `packages/mcp` | Sakib | T18 |
| [executor](executor.md) | `packages/executor` | Shaukat | T21, T22 |
| [web](web.md) | `apps/web` | Sakib | T10, T17, T20, T23, T26 |
| [eval](eval.md) | `eval` | Shaukat (labels, runner), Sakib (baseline tools) | T24 |
| [deploy](deploy.md) | configuration and hosting | Sakib | T25 |
