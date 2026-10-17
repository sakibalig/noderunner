# Most of your npm alerts don't matter. A graph can show you which ones do.

*Team Noderunner (Shaukat Ali, Sakib Khan), for Graph Hacks by WeMakeDevs and FalkorDB, Track 1: Agents That Act on
Connected Data. Code: <https://github.com/sakibalig/noderunner>*

Run `npm audit` on any real Node project and you get a wall of alerts. On `nestjs/nest` it is 56: 2 critical, 25
high, 24 moderate, 5 low. Most teams end up doing one of two things. They ignore the list, or they burn an afternoon
working out which alerts can actually touch production. Research presented at NDSS this year (VulTracer) found that
68% of package-level vulnerability impacts in npm are noise, because the vulnerable code is never reached. The hard
part is telling which 68%.

Noderunner is our answer: an agent that loads a repository into a FalkorDB graph, follows the path from production
code to each vulnerable package, plans the cheapest upgrades that fix the alerts that matter, and opens a pull
request that it has verified first. Every claim it makes comes with the graph path behind it.

## The question is a graph traversal

Whether an alert matters is a chain:

> production file → package it imports → the copy npm installed → that copy's dependencies → … → the vulnerable
> version → the fix → the people who own that code

That is a path query, so we answer it in the graph instead of asking a model to guess. Ingestion reads the commit's
tarball in memory (nothing is cloned or executed), resolves `package-lock.json` the way Node resolves modules,
parses every import with Babel, looks up every installed version in OSV, and reads CODEOWNERS and git history. The
result is one FalkorDB graph per repository: `File`, `Install`, `Package`, `Vuln`, `Person`, joined by `IMPORTS`,
`LOADS`, `DEPENDS_ON`, `AFFECTS`, `OWNS`, and `CHANGED`.

The tier of every alert then comes from one query: the shortest `DEPENDS_ON` path, at most 15 hops, from any install
a production file loads to any install the advisory affects.

```cypher
MATCH (x:Finding)-[:AT]->(bad:Install)
MATCH (f:File {kind: "prod"})-[l:LOADS]->(entry:Install)
WITH x, bad, entry, f, l
WITH x, entry, shortestPath((entry)-[:DEPENDS_ON*0..15]->(bad)) AS p
WHERE p IS NOT NULL
...
```

On `nestjs/nest` that turns 56 alerts into **10 that production code can reach**, each with its chain. For example,
`packages/platform-socket.io/adapters/io-adapter.ts` imports `socket.io` on line 14, `socket.io` depends on
`socket.io-adapter`, and `socket.io-adapter` pins `ws` 8.18.3, which has two advisories. The other 46 sit only in the
dev tree.

We checked the graph against outside sources rather than trusting it. Its 1,638 installs, 1,460 of them dev, and 97
direct dependencies match the lockfile exactly. Its 56 advisories are the same 56 that `npm audit` reports on the
same lockfile, none missing on either side.

## An agent that has to show its work

The triage agent is gpt-5 with typed tools: `list_alerts`, `reachability`, `introduced_by`, `plan_upgrades`,
`owners_for`, `recall_decisions`, `record_decision`, and a read-only Cypher escape hatch. The model chooses which
tools to call and writes the report. It never decides a tier or an upgrade; those come from code, so the same commit
gives the same answer.

Two rules keep it honest:

- **Every tool call is a node.** Each call is stored as a `Step` linked with `TOUCHED` to the graph nodes it read.
  The report has to end every factual sentence with a citation like `[s:<stepId>]`, and the loop checks the report
  against the run's own tool results before anyone sees it: a citation to a step that does not exist, or a funnel
  number that differs from the tool's, sends the report back once for correction.
- **Click a citation, see the path.** In the web app the run streams in live, and clicking a citation lights up the
  exact chain in a Cytoscape view of the graph, with the Cypher that found it.

The upgrade plan is a weighted set cover over three kinds of fix: a lockfile refresh within the declared ranges
(cost 1), a direct bump (2, or 5 for a major), or an `overrides` pin (4, a workaround). On nest, **three upgrades
close all ten reachable alerts at cost 6**, and the agent names reviewers from CODEOWNERS and recent commits.

## Acting, carefully

Track 1 asks for agents that act, so Noderunner opens the pull request. Before it pushes anything, it checks its own
work:

1. A person approves the plan in the UI. Nothing ships without that.
2. It edits `package.json`, splicing in only the changed values, so the diff is exactly the change.
3. npm regenerates the lockfile with `--ignore-scripts`, in a temporary folder that holds only the package manifests
   and the lockfile. The repository's code never meets a process.
4. It **re-ingests the regenerated lockfile into a separate verification graph and re-runs the tier query**. If the
   change would make any new alert reachable, it refuses to open the pull request.
5. Only then does it push the two files to the fork through GitHub's Git Data API and open the pull request, with
   the verification in the description.

Real repositories make this harder than it sounds. Nest is a monorepo, so npm needs every workspace's `package.json`
or it silently drops the workspace entries from the lockfile. Its lockfile cannot be rebuilt with strict peer
resolution, so the sandbox retries with `--legacy-peer-deps`. And npm refuses an override of a package the root also
depends on directly, so the executor writes npm's `$ws` reference instead. In a dry run on nest, the regenerated
lockfile **closed 10 of 10 targeted alerts with no new ones**, in about 15 seconds. That includes the
`brace-expansion` copy several levels down, which the refresh lifted from 5.0.5 to 5.0.12.

## Memory that goes stale visibly

Waivers are part of the graph too. Waive an alert in the UI and the next run recalls it. A waiver is never kept
silently past its reasons, though: it is flagged as stale when it expires, when its finding becomes reachable, when
the advisory changes, or when a worse vulnerability appears on the same install. When we waived one of nest's `ws`
alerts, the next run flagged it at once, because the same `ws` copy carries a more severe advisory. A stale waiver
also reopens its finding, so the planner covers it again.

## Does the graph actually help? We measured it

We gave a baseline agent the same model, goal, call limit, and report format, but no graph. It gets the alert list
(without our tiers), a text search, and a file reader over the source, every `package.json`, and the lockfile. Both
ran three times on nest and were scored against labelled alerts:

| Agent | Precision | Recall | Tool calls | Time |
| --- | --- | --- | --- | --- |
| Graph agent | 100% | 83% (3 of 3 runs) | 9–11 | ~51 s |
| Baseline, files only | 100% (2 of 3 runs) | 25% (0–25%) | 15, capped every run | ~85 s |

The baseline is not careless. It finds packages that production code imports directly. What it cannot do in 15 calls
is the dependency walk: seven of nest's reachable alerts are in `brace-expansion`, which no file imports. It arrives
through `@fastify/static` → `glob` → `minimatch`. Text search sees an import of `@fastify/static`; the graph sees
where that leads.

The graph agent's 17% miss is real too, and we found it by checking our labels with an independent script that
shares no code with Noderunner. Nest loads gRPC with `createRequire(import.meta.url)('@grpc/grpc-js')`, which our
import parser does not resolve, so two `protobufjs` alerts are reachable in practice and our graph says dev-only. We
kept them in the labels as corrections rather than hide them.

Limits we state with the numbers: one repository; labels that start from the tool's own tiers (five checked by hand
against the source and lockfile, and all 56 by the independent script); and "reachable" means production code loads the package, not
that the vulnerable function is called. Tools like VulTracer go further, to function level.

## What we learned about FalkorDB

FalkorDB fit this problem well: one graph per repository gave clean tenant isolation, `shortestPath` over
`DEPENDS_ON` answers reachability for every alert in one query (under a second on nest), and the same graph doubles
as the agent's memory of runs, steps, plans, and decisions. A few things surprised us, and each is handled in
`packages/graph`:

- Reads time out after one second by default in the Docker image, so every call sends its own `TIMEOUT`.
- `shortestPath` works only as a projection, in `WITH` or `RETURN`, not in `MATCH`. A minimum length of 0 is
  allowed, which covers a file that loads the vulnerable package itself.
- A query parameter named `cypher` breaks the Node client, which sends parameters as a `CYPHER name=value` prefix.
- Reading a graph that does not exist creates it, so we check the graph list first.
- `CREATE INDEX` is not idempotent, so migrations read `db.indexes()` first.
- With no `error` listener, a dropped connection crashes the process.
- Writes ignore `TIMEOUT`, so we batch writes in chunks of 500 with `UNWIND` and check for cancellation between them.

## Try it

```bash
pnpm install
docker compose up -d falkordb
FALKORDB_URL=redis://localhost:6379 pnpm triage nestjs/nest
```

That needs no API key. The agent, the web app, and the pull request need an OpenAI key and a GitHub token; the
README has the full setup. Everything is open source under MIT: <https://github.com/sakibalig/noderunner>.
