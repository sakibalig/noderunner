# Documentation

Design and reference for Noderunner: the high-level architecture, one design per component, and the standards every
change is held to. Shapes shared across the two halves of the team live in [contracts](../../contracts), and
sequence lives in the [delivery plan](../../nimbalyst-local/plans/noderunner.md).

| Document | What it covers |
| --- | --- |
| [architecture.md](architecture.md) | Purpose, system context, layering, the ingestion, triage, and action flows, memory, deployment, evaluation, known gaps |
| [components](components) | One low-level design per package: interface, behaviour, failures, tests, open points |
| [standards/engineering.md](standards/engineering.md) | The bar the code is built to |
| [standards/review.md](standards/review.md) | The review a change is judged against before it merges |

The root [AGENTS.md](../../AGENTS.md) is the entry point every contributor and coding agent reads first. New pages
are added here — the blog post draft, the demo script, the eval results — as each becomes stable.
