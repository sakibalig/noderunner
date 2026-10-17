# Documentation

Design and reference for Noderunner: the high-level architecture, one design per component, and the standards every
change is held to. Shapes shared across the two halves of the team live in [contracts](../../contracts), and
sequence lives in the [delivery plan](plan.md).

| Document | What it covers |
| --- | --- |
| [architecture.md](architecture.md) | Purpose, system context, layering, the ingestion, triage, and action flows, memory, deployment, evaluation, known gaps |
| [components](components) | One low-level design per package: interface, behaviour, failures, tests, open points |
| [standards/engineering.md](standards/engineering.md) | The bar the code is built to |
| [standards/review.md](standards/review.md) | The review a change is judged against before it merges |
| [plan.md](plan.md) | Tasks, owners, cut order, decisions, risks, and the reconciliation record |
| [demo/script.md](demo/script.md) | The three-minute video: shots, timings, narration, fallback |
| [runbook/deploy.md](runbook/deploy.md) | Running the demo locally: configuration, start, pre-load, evaluation, failures |
| [tracks/sakib.md](tracks/sakib.md) | Sakib's stage-by-stage working plan, hand-offs with Shaukat, and cut order |

The root [AGENTS.md](../../AGENTS.md) is the entry point every contributor and coding agent reads first. New pages
are added here — the blog post draft, the demo script, the eval results — as each becomes stable.
