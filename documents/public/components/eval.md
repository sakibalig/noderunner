# `eval`

The evaluation proves, or fails to prove, that the graph shapes what the agent does. It scores the graph agent and a
baseline agent with the same model and goal but no graph traversal against hand labels on three pinned public
repositories. Its single responsibility is a reproducible, honest comparison whose numbers go unedited into the
README, the blog post, and the video.

| Owner | Tasks | Layer | Depends on |
| --- | --- | --- | --- |
| Shaukat (labels, runner), Sakib (baseline tools) | T24 | Evaluation, with its own composition root | `apps/worker` (`runAgent`), `packages/ingest`, `packages/executor` (`verify`), `packages/core`; real FalkorDB, the OpenAI API, Docker |

## Responsibility

It owns the label files, the contract of the baseline agent's two extra tools, the runner, the metric definitions,
and the two results files. The tools themselves live in `packages/tools/src/baseline/` (R18), owned by Sakib, so
the worker can offer them without depending on `eval`. It does not change how either agent triages: both run the
production agent loop through
`runAgent`, so the comparison measures the tools, not a separate harness. It never runs against the hosted
FalkorDB, so it cannot touch the pre-loaded demo graphs.

## Layout

```
eval/
  repos.json                  the three repositories and their pinned commits (D6)
  labels/<owner>/<name>.json  one label file per repository
  src/main.ts                 composition root for `pnpm eval`
  src/run.ts                  runs both agents on one repository
  src/score.ts                the metrics, pure
  src/table.ts                renders results.md from results.json, pure
  results.json  results.md    generated, committed with the commit they were produced at
```

## Labels

```json
{
  "repo": "owner/name",
  "sha": "<pinned commit>",
  "labels": { "GHSA-xxxx-xxxx-xxxx|qs": "import-reachable", "GHSA-yyyy-yyyy-yyyy|minimist": "dev-only" },
  "corrections": [
    { "key": "GHSA-zzzz-zzzz-zzzz|semver", "tool": "installed", "label": "import-reachable",
      "why": "src/build.ts requires it through a tsconfig path alias, which ingestion does not resolve" }
  ]
}
```

Every finding at the pinned commit has exactly one label, keyed by `findingKey()`. The schema is a zod object in
`eval/src`, parsed on load; a file whose `sha` differs from `repos.json`, or a finding without a label, stops the
runner.

**How labels are made.** Following the LLD, labelling starts from the tool's tiers and corrects them by reading the
code, and every change from the tool's answer is recorded in `corrections` with the reason. Starting from the tool
risks anchoring, so each label is checked independently of the tier it started as: an `import-reachable` label by
opening the production file and following the chain the tool reports, and every other label by searching the
source for the package name and its importers, including dynamic `require` and path aliases. The corrections list is
published with the results; it doubles as the honest list of what import-level reachability gets wrong.

Labels are frozen, committed, before the first scored run. A later change is a new commit with a correction entry,
and the results are regenerated rather than edited.

## Baseline tools

The baseline agent gets `list_alerts`, unchanged, plus two tools that never touch the graph, per
[tools.md](../../../contracts/mcp/tools.md#who-gets-which-tools). They live in `packages/tools/src/baseline/` and are
registered for the baseline actor only (R18):

| Tool | Input | Output | Limits |
| --- | --- | --- | --- |
| `search_files` | `{ text: string, glob?: string }` | `{ matches: { path, line, excerpt }[], truncated }` | Literal substring of at most 200 characters, not a regular expression, so a model-written pattern cannot backtrack; 50 matches; excerpts 200 characters |
| `read_file` | `{ path: string, offset?: number }` | `{ path, offset, lines: string[], truncated }` | One file, 400 lines from `offset`; the path must be one of the fetched files |

Both read the in-memory file set from ingestion stage 1 at the pinned commit, the same files the graph agent's
import parser saw. Both go through `callTool`, so each call writes a Step and counts toward the 15-call cap, and
both wrap file text as quoted data. Same model, same system goal, same report format, including the `result` block.

## Runner

`pnpm eval` runs `eval/src/main.ts`, which parses its configuration (`FALKORDB_URL`, `LLM_PROVIDER`, `LLM_MODEL`, the provider key,
`GITHUB_TOKEN`) through the core env schema and builds the same adapters as the worker.

1. Refuse to start if `FALKORDB_URL` is the hosted instance, or if any target graph holds a `Decision` node, since
   waivers change the plan. The runner never drops a graph; the operator does.
2. For each repository in `repos.json`, ingest at the pinned commit and check that every finding is labelled.
3. Run `triage` and `baseline` three times each, alternating, through `runAgent` with a fresh run id.
4. For each run, read `Run.result`, `Run.tokens_in`, `Run.tokens_out`, and the run's Steps from the graph (R19).
5. Turn each run's proposed upgrades into a plan and call the executor's `verify`, which regenerates the lockfile
   in the sandbox and re-tiers it in `verify:<runId>` without pushing anything. A baseline upgrade becomes a `bump`
   when the package is a direct dependency and an `override` otherwise.
6. Score, write `results.json` with every run and its raw numbers, and render `results.md` from it.

Both agents end their report with a fenced `result` block,
`{ mustFix: FindingKey[], upgrades: { package: string, to: string }[] }`: finding keys and target versions. The
agent loop parses it and stores it as `Run.result` ([agent](agent.md#report-format)); the runner reads that value and
never parses report text itself. A run whose `Run.result` is null, because the block was missing or malformed, scores
an empty set and is reported as such, never re-run until it passes.

## Metrics

| Metric | Definition |
| --- | --- |
| Precision | `#(mustFix ∩ L) / #mustFix`, where `L` is the keys labelled `import-reachable`; "n/a" when `mustFix` is empty |
| Recall | `#(mustFix ∩ L) / #L` |
| Upgrades proposed | `upgrades.length` |
| Closed after verification | `closed` from the executor's verification of those upgrades, and its `newFindings` count beside it |
| Tool calls | Steps in the run |
| Wall time | `finished_at − started_at` of the run |
| Tokens | `Run.tokens_in` and `Run.tokens_out`, summed by the agent loop over the run's model turns |

`results.md` has one table per repository with a row per agent: the median of three runs, with the minimum and
maximum beside each value. The deterministic parts — tiers and the graph agent's plan — are the same in all three
runs, and a difference there is a bug, not variance.

## Honesty rule

The results are reported as they are. If the baseline comes close, or wins, on a repository, that row is shown and
explained, not dropped; a truthful comparison convinces technical judges more than a lopsided one. All three runs
of every agent count, failed and capped runs included. No metric is added or removed after seeing the numbers.
Every number quoted in the README (T30), the blog post (T32), and the video's comparison segment (T31) is copied
from one committed `results.md`, named by its commit. The compare page (T26) shows two runs side by side and no eval
scores, so the web app never reads `results.json` (R20).

## Failures

Configuration and label errors stop the runner before any model call, with the file and key named. A failed
ingestion stops that repository and is recorded. A run that fails, is capped, or ends `unverified` is scored as it
stands. A `verify` failure (`upstream`, which covers the sandbox, or `range` for a dependency range the executor
cannot rewrite) records the closed count as "not verified" for that run rather than estimating it.

## Tests

- `score.ts`: a table of `mustFix` and label sets — exact match, one false positive, one miss, empty `mustFix`,
  empty `L` — with expected precision and recall.
- `table.ts`: a recorded `results.json` renders to the checked-in `results.md` byte for byte.
- Label loading: a missing label, an unknown tier, and a `sha` mismatch each fail with the key or file named.
- Result: a run with a null `Run.result` scores an empty set and is listed as such; token counts are read from the
  `Run`, not recomputed.
- `search_files` and `read_file` over `fixtures/mini-repo`: a literal `.*` matches only the text `.*`; the 51st
  match sets `truncated`; a path outside the fetched set is a `ToolErr`; line 401 is not returned from offset 0.
- The runner end to end on `fixtures/mini-repo` with a recorded model transcript and the fake sandbox, against real
  FalkorDB: one repository, one run per agent, and a `results.json` that matches the snapshot.

## Open points

Decisions are tracked in the [delivery plan](../plan.md#8-decisions).

- **[D6](../plan.md#8-decisions):** the three repositories and their commits;
  `repos.json` stays empty until S4 answers.
