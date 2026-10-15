# Graph schema

The FalkorDB contract. Ingestion writes it, the tools and the planner read it, the executor and the agent write
their memory into it, the UI draws it, and a model or an MCP client may query it through `read_only_cypher`. Every
label, key, and relationship type below is fixed; adding one is an additive contract change, and renaming or
removing one is a breaking change.

## Graphs

| Graph name | Holds | Lifetime |
| --- | --- | --- |
| `repo:<owner>/<name>` | One repository's supply chain, people, and agent memory | Kept across re-ingests; dropped only by an operator |
| `advisories` | A cache of OSV records keyed by package and version, shared by every repository | Entries refreshed after 24 hours |
| `verify:<runId>` | A fresh ingest of the repository's source files with the edited `package.json` and the regenerated lockfile | Dropped when verification finishes, on success or failure |

A graph name is lowercase and built only by `graphName(repo)` in `packages/core`. FalkorDB queries do not span
graphs, so relevant vulnerabilities are copied from `advisories` into each repository graph at ingest. A caller never
supplies a graph name: the worker takes it from the run record and the MCP server from `MCP_GRAPH`.

## Conventions

- Properties are `snake_case`. Timestamps are integers in epoch milliseconds. Structured values that are not
  traversed (OSV ranges, a tool's input) are stored as JSON strings.
- Every supply-chain node and edge carries `snapshot_sha`, the commit it was last seen at.
- Memory nodes — `Run`, `Step`, `Finding`, `Plan`, `Upgrade`, `Decision`, `PullRequest` — carry no
  `snapshot_sha` and are never deleted by ingestion.
- FalkorDB internal ids (`id(n)`) are used for evidence within one snapshot only. They can be reused after a node is
  deleted, so anything stored long-term refers to a node by its key property, never by its internal id.

## Supply chain

| Label | Key | Properties |
| --- | --- | --- |
| `Repo` | `url` | `owner`, `name`, `default_branch`, `snapshot_sha`, `ingested_at` |
| `File` | `path` | `kind` (`prod`, `test`, `script`, `config`), `is_entry`, `snapshot_sha` |
| `Package` | `name` | — |
| `Install` | `lock_path` | `name`, `version`, `purl`, `dev`, `optional`, `snapshot_sha` |
| `Vuln` | `id` | `aliases`, `severity` (`critical`, `high`, `moderate`, `low`, `unknown`), `severity_rank` (4 to 0), `cvss`, `summary`, `published`, `modified`, `ranges` (JSON, keyed by package name), `fixed` (list) |
| `Person` | `handle` | `name`, `kind` (`user`, `team`) |

`Install` is one node per entry in the lockfile's `packages` map, keyed by its install path such as
`node_modules/a/node_modules/b`, because npm can install one package at several versions. `Install.dev` is true when
the lockfile marks the entry `dev` or `devOptional`. `Vuln.severity_rank` maps `critical` to 4 down to `unknown` at 0,
and is what the staleness rule compares.

| Relationship | From → to | Properties | Meaning |
| --- | --- | --- | --- |
| `CONTAINS` | `Repo` → `File` | — | The file exists at the snapshot |
| `IMPORTS` | `File` → `File` | `snapshot_sha` | A relative import, resolved |
| `IMPORTS` | `File` → `Package` | `specifier`, `snapshot_sha` | A bare import; the subpath is kept in `specifier` |
| `LOADS` | `File` → `Install` | `snapshot_sha` | The root-level install Node would load for that bare import |
| `DECLARES` | `Repo` → `Install` | `range`, `dev`, `snapshot_sha` | A direct dependency from `package.json` |
| `OF` | `Install` → `Package` | — | The install is a copy of the package |
| `DEPENDS_ON` | `Install` → `Install` | `range`, `kind` (`prod`, `optional`, `peer`), `snapshot_sha` | Resolved from the lockfile the way Node resolves |
| `AFFECTS` | `Vuln` → `Install` | `snapshot_sha` | The installed version is inside an affected range |
| `IN_PACKAGE` | `Vuln` → `Package` | — | The advisory names the package |
| `OWNS` | `Person` → `File` | `source` (`codeowners`) | The last matching CODEOWNERS rule names the person |
| `CHANGED` | `Person` → `File` | `commits`, `last_at` | Commit count and latest date in the last 200 commits |

## Agent memory and evidence

| Label | Key | Properties |
| --- | --- | --- |
| `Run` | `id` | `agent` (`triage`, `fixer`, `baseline`, `mcp`, `ui`), `model`, `status` (`running`, `done`, `failed`, `capped`), `unverified`, `started_at`, `finished_at`, `report`, `result` (JSON), `tokens_in`, `tokens_out` |
| `Step` | `id` | `seq`, `tool`, `input` (JSON), `ok`, `summary`, `cypher` (list), `edges` (JSON list of edge keys), `ms` |
| `Finding` | `key` | `vuln_id`, `package`, `severity`, `tier` (`import-reachable`, `installed`, `dev-only`), `status` (`open`, `planned`, `fixed`, `waived`), `fixed_at` |
| `Plan` | `id` | `created_at`, `total_cost`, `uncovered` (list of finding keys), `approved`, `approved_by`, `approved_at` |
| `Upgrade` | `id` | `kind` (`refresh`, `bump`, `override`), `package`, `from`, `to`, `semver_jump` (`patch`, `minor`, `major`), `cost` |
| `Decision` | `id` | `kind` (`waive`, `accept`, `reject`), `reason`, `created_at`, `expires_at`, `tier_at_decision`, `stale_reason` |
| `PullRequest` | `url` | `number`, `branch`, `state`, `targeted`, `closed`, `new_findings` |

`Finding.key` is `<vulnId>|<package>`, built only by `findingKey()` in `packages/core`. Keying on the package rather
than the install path is what lets a finding, and every decision about it, survive a re-ingest that moves the
install. A finding stays `planned` while its pull request is open and becomes `fixed` when a later ingest of the
default branch no longer finds an affected install. `Run.result` holds the structured result block the agent ends
its report with — the must-fix finding keys and the proposed upgrades — which evaluation scores.

| Relationship | From → to | Meaning |
| --- | --- | --- |
| `HAS_STEP` | `Run` → `Step` | The run made the tool call |
| `TOUCHED` | `Step` → any | The node was part of the call's evidence |
| `FOUND` | `Run` → `Finding` | The run listed the finding |
| `ABOUT` | `Finding` → `Vuln` | The finding is this vulnerability |
| `AT` | `Finding` → `Install` | An install the vulnerability affects at the current snapshot; carries `snapshot_sha` |
| `PROPOSED` | `Run` → `Plan` | The run produced the plan |
| `INCLUDES` | `Plan` → `Upgrade` | The plan contains the upgrade |
| `CLOSES` | `Upgrade` → `Finding` | The upgrade is expected to close the finding |
| `REVIEW_BY` | `Upgrade` → `Person` | A suggested reviewer, with `why` on the edge |
| `ABOUT` | `Decision` → `Finding` | The decision concerns the finding |
| `MADE_BY` | `Decision` → `Person` | Who decided |
| `SUPERSEDES` | `Decision` → `Decision` | The newer decision replaces the older one |
| `SHIPPED_AS` | `Plan` → `PullRequest` | The plan was opened as this pull request |

## Re-ingest

Ingestion at a new commit `MERGE`s on the keys above and stamps the new `snapshot_sha`, then prunes: every `File`
and `Install` with an older `snapshot_sha` is detach-deleted, and every `IMPORTS`, `LOADS`, `DECLARES`,
`DEPENDS_ON`, `AFFECTS`, and `AT` edge with an older `snapshot_sha` is deleted. A `Finding` in status `open` or `planned`
left with no `AT` edge is set to `fixed` with `fixed_at`. Memory nodes are never deleted, so a deleted install also
removes the `TOUCHED` edges that pointed at it; old steps keep their summary and queries.

## Indexes

```cypher
CREATE INDEX FOR (r:Repo)    ON (r.url)
CREATE INDEX FOR (f:File)    ON (f.path)
CREATE INDEX FOR (p:Package) ON (p.name)
CREATE INDEX FOR (i:Install) ON (i.lock_path)
CREATE INDEX FOR (v:Vuln)    ON (v.id)
CREATE INDEX FOR (x:Finding) ON (x.key)
CREATE INDEX FOR (p:Person)  ON (p.handle)
CREATE INDEX FOR (r:Run)     ON (r.id)
CREATE INDEX FOR (s:Step)    ON (s.id)
```

`migrate()` in `packages/graph` creates them and is idempotent. In the `advisories` graph:
`(:PV {key, name, version, checked_at})-[:HAS]->(:Adv {id, record, modified})`, indexed on `PV.key` and `Adv.id`.
