# `packages/ingest`

`packages/ingest` turns one public npm repository at one commit into a repository graph: its files and imports,
its installed packages and how Node resolves them, the vulnerabilities that affect them, the people who own the
code, and a findings list the agent triages. Its single responsibility is to make the graph an exact, idempotent
picture of one commit, built from text only, so that every tier and plan downstream is computed from facts rather
than guesses. No code from the repository is ever executed.

| Owner | Tasks | Layer | Depends on |
| --- | --- | --- | --- |
| Shaukat Ali (stages 1–4, 6), Sakib Khan (stage 5) | T04–T08, T19 | Application | `@noderunner/core`, `@noderunner/graph/cypher`, `tar-stream`, `@babel/parser`, `ignore` |

## Responsibility

It owns the six stages of [architecture.md](../architecture.md#5-flow-ingestion), the warnings they collect, the
`IngestReport`, and the shared `advisories` cache graph. It is the only writer of supply-chain nodes and edges and,
under change C7, of `Finding`, `ABOUT`, and `AT`; `list_alerts` only writes `FOUND`. It never deletes a memory node,
never reads `process.env`, and never decides a tier: `Finding.tier` is set by `reachability` in [tools](tools.md).

It reaches GitHub, OSV, and FalkorDB only through the core ports `Forge`, `Advisories`, and `G`, and takes its
Cypher from `@noderunner/graph/cypher`. Each stage is a file: `src/stages/fetch.ts`, `lockfile.ts`, `imports.ts`,
`advisories.ts`, `people.ts`, `prune.ts`, with the import parser in `src/parse/` and `src/index.ts` running them.

## Interface

```ts
function ingest(repo: RepoRef, deps: Deps, opts: Opts): Promise<IngestReport>;

type Target =
  | { kind: "repo" }
  | { kind: "verify"; runId: RunId; override: { manifest: string; lock: string } };   // R6
type Deps = { db: Db; forge: Forge; advisories: Advisories; clock: Clock };
type Opts = {
  target: Target;
  onProgress: (e: Extract<RunEvent, { type: "ingest.progress" }>) => void;
  signal: AbortSignal;
};
```

`IngestReport` and `Warning` are the core types; the worker wraps the report in `ingest.finished`. `Target`
replaces the LLD's optional `graph` and its lockfile-only override with a union. `override` carries the edited
`package.json` as well as the regenerated lockfile, because a bump changes the declared range that stage 2 writes
onto `DECLARES`.

| Target | Graph | Stages | `snapshot_sha` stamp |
| --- | --- | --- | --- |
| `repo` | `graphName(repo)` | 1–6 | the commit |
| `verify` | `verifyName(runId)`, new and empty | 1, 2, 3, 4, 6, with `override.manifest` and `override.lock` replacing the fetched package files | the commit |

Verification is a full ingest, not a partial one over a copy (R6, which resolves D4): the executor passes the
repository graph's `snapshot_sha` in `repo.sha`, so stage 1 reads exactly the source files that graph was built
from, and only the two package files differ. Every file, import, and `LOADS` edge is therefore derived afresh and
stage 6 prunes as usual. Stage 5 is skipped, because people do not affect a tier.

## Stages

Each stage emits `ingest.progress` with its own `done` and `total`, checks the signal between batches, and records
its duration in `report.ms`.

**1. Fetch (T04).** Without a `sha`, `forge.head` gives the default branch and its commit. The stage `MERGE`s the
`Repo` on its URL with `owner`, `name`, and `default_branch`; `snapshot_sha` and `ingested_at` wait for stage 6, so a
failed ingest leaves the previous stamp in place. `forge.tarball` is streamed through `node:zlib` and `tar-stream`,
stripping the archive's top-level folder. It keeps the root `package.json` and `package-lock.json`, the first
CODEOWNERS found in GitHub's order (`.github/`, root, `docs/`), and files ending `.js .mjs .cjs .ts .mts .cts .tsx
.jsx`. It skips any path through `node_modules/`, `dist/`, `build/`, `.next/`, `coverage/`, or `vendor/`, any
`*.min.js`, any entry that is not a regular file, and any source file over 512 KB; skipped entries are drained
without buffering. The 512 KB limit does not apply to the two package files, since a lockfile of 1,500 installs
exceeds it; they have a 20 MB limit. Kept source stops at 50 MB, after which further files are counted as a
`skipped` warning. Under a `verify` target the fetched `package.json` and `package-lock.json` are dropped and the
override's two texts take their place, under the same limits. Both package files are parsed with zod: no lockfile,
or a `lockfileVersion` other than 2 or 3, fails with `ingest.lockfile`.

**2. Lockfile (T05).** The `packages` map gives one `Install` per key; `""` is the root project and `link` entries
are workspace links, both skipped. Dependencies resolve the way Node does, walking up from the requiring install:

```ts
for (const [lockPath, entry] of Object.entries(lock.packages)) {
  if (lockPath === "" || entry.link) continue;
  const name = entry.name ?? lockPath.slice(lockPath.lastIndexOf("node_modules/") + 13);
  installs.push({ lock_path: lockPath, name, version: entry.version, purl: purl(name, entry.version),
                  dev: Boolean(entry.dev || entry.devOptional), optional: Boolean(entry.optional) });
}
function resolve(fromPath: string, dep: string, have: ReadonlySet<string>): string | null {
  let base = fromPath;
  for (;;) {
    const candidate = (base ? `${base}/` : "") + `node_modules/${dep}`;
    if (have.has(candidate)) return candidate;
    if (!base) return null;
    const i = base.lastIndexOf("/node_modules/");
    base = i === -1 ? "" : base.slice(0, i);
  }
}
```

Each install's `dependencies`, `optionalDependencies`, and `peerDependencies` become `DEPENDS_ON {range, kind}` to
`resolve(install.lock_path, dep)`. The root `dependencies` and `optionalDependencies` become `DECLARES {dev: false}`
and `devDependencies` `DECLARES {dev: true}`, each to `resolve("", dep)`. An unresolved optional or peer dependency
is skipped silently; an unresolved regular one is an `unresolved` warning. Three batched writes follow:

```cypher
// lockfile.installs
UNWIND $rows AS r
MERGE (p:Package {name: r.name})
MERGE (i:Install {lock_path: r.lock_path})
SET i.name = r.name, i.version = r.version, i.purl = r.purl, i.dev = r.dev, i.optional = r.optional,
    i.snapshot_sha = $sha
MERGE (i)-[:OF]->(p)

// lockfile.depends
UNWIND $rows AS r
MATCH (a:Install {lock_path: r.from}), (b:Install {lock_path: r.to})
MERGE (a)-[e:DEPENDS_ON]->(b) SET e.range = r.range, e.kind = r.kind, e.snapshot_sha = $sha

// lockfile.declares
UNWIND $rows AS r
MATCH (repo:Repo {url: $url}), (i:Install {lock_path: r.to})
MERGE (repo)-[e:DECLARES]->(i) SET e.range = r.range, e.dev = r.dev, e.snapshot_sha = $sha
```

**3. Imports (T06).** Each file is parsed by `@babel/parser` with `sourceType: "unambiguous"`,
`errorRecovery: true`, `decorators-legacy`, and `typescript` for TypeScript extensions, adding `jsx` only for `.tsx`,
or `jsx` alone for JavaScript. An iterative walk over an explicit stack, not `@babel/traverse`, collects string
sources from `ImportDeclaration`, `ExportNamedDeclaration`, `ExportAllDeclaration`, dynamic `import("x")`,
`require("x")`, `require.resolve("x")`, and `import x = require("x")`, skipping `import type` and `export type`. If
parsing throws, a regex over `from "x"`, `require("x")`, and `import("x")` is used instead, with a `parse` warning.

A specifier is resolved by its form. A relative one (`./`, `../`) tries the exact path, the path plus each source
extension, then `/index` plus each, and maps `.js` to `.ts` or `.tsx`, `.mjs` to `.mts`, and `.cjs` to `.cts` for
TypeScript ESM; it resolves to a `File`, and a non-source target such as `.json` or `.css` is ignored. A `node:`
specifier or a name in `builtinModules` is ignored. A bare one names the package by its first segment, or its first
two when it starts with `@`, and keeps any subpath as `specifier`. One that is not a valid npm package name, such as
`@/x` or `~/x`, is a `tsconfig` alias and an `alias` warning; a valid name with no installed package is
`unresolved`.

Each file gets `kind` by the first matching rule, `test`, `config`, `script`, then `prod`, using the path lists of
the LLD unchanged: `test` is `__tests__/`, `__mocks__/`, `.test.`, `.spec.`, top-level `test/`, `tests/`, `e2e/`,
`cypress/`, `playwright/`, `.storybook/`, and `*.stories.*`; `config` is `*.config.*`, `.eslintrc*`,
`babel.config.*`, and `jest.setup.*`; and `script` is top-level `scripts/`, `tools/`, and `bench/`. `is_entry` is
true for files named by `main`, `module`, `bin`, and every string leaf of `exports` in `package.json`, files under
`pages/`, `app/`, `src/pages/`, `src/app/`, and `src/index.*`, `index.*`, and `server.*`. Writes are `File` with
`CONTAINS` from the `Repo`, `IMPORTS` to a `File`, `IMPORTS {specifier}` to an existing `Package`, and `LOADS` to the
install `resolve("", pkg)` names, all batched and stamped.

**4. Advisories (T07).** Distinct `(name, version)` pairs are read from the installs and looked up in the
`advisories` graph (`cache.ts`), where `(:PV {key: "name@version", checked_at})-[:HAS]->(:Adv {id, record,
modified})`; a `PV` checked within 24 hours is a hit, and one with no `HAS` edge means "checked, clean". Misses go to
`advisories.query`, which chunks them at the OSV batch limit (D5). Records are fetched with `advisories.record`, at
most eight at once, only for ids not cached or whose `modified` is newer than the cached `Adv`. The cache is written
before the repository graph, so a retried ingest pays only for what failed. Each record is normalised:

| `Vuln` property | Source |
| --- | --- |
| `severity`, `severity_rank` | `database_specific.severity` lowercased when it is one of the four levels, else `unknown`; rank from core's `rank` (C5) |
| `cvss` | the `CVSS_V3`, else `CVSS_V4`, vector in `severity[]`, else absent |
| `summary`, `aliases` | as given, `summary` cut to 500 characters; it is untrusted text and reaches the model only as data |
| `published`, `modified` | RFC 3339 converted to epoch milliseconds |
| `ranges` | a JSON object from package name to that package's `affected[].ranges`, for the packages this repository installs |
| `fixed` | the sorted distinct `fixed` events across those ranges |

An install gets `AFFECTS` when OSV listed the vulnerability for its exact name and version. Core's `isAffected` is
evaluated on the same pair, and a disagreement is a `range` warning, so the planner never silently works from
ranges that contradict OSV. Each `(vulnerability, package)` with an affected install becomes a `Finding`:

```cypher
// advisories.findings
UNWIND $rows AS r
MATCH (v:Vuln {id: r.vuln_id})
MERGE (x:Finding {key: r.key})
ON CREATE SET x.vuln_id = r.vuln_id, x.package = r.package, x.status = "open"
WITH x, v, x.status = "fixed" AS reopened
SET x.severity = v.severity,
    x.status = CASE WHEN reopened THEN "open" ELSE x.status END,
    x.fixed_at = CASE WHEN reopened THEN null ELSE x.fixed_at END
MERGE (x)-[:ABOUT]->(v)
```

`advisories.at` then `MERGE`s `(x)-[a:AT]->(i)` for each affected install and sets `a.snapshot_sha = $sha`. A `planned` or `waived` finding keeps its
status; a `fixed` one that reappears is reopened.

**5. People (T08, Sakib).** CODEOWNERS lines become `(pattern, owners[])`; a path's owners come from the last rule
whose pattern matches it under the `ignore` package's gitignore semantics. `@org/team` becomes one `Person` with
`kind: "team"`, `@user` one with `kind: "user"`, and an e-mail owner is dropped with a `people` warning. History comes
from `forge.history(repo, sha, 200)`, whose adapter runs `git clone --filter=blob:none --depth=200 --no-checkout
--single-branch` in a temporary folder it deletes in `finally`, and pairs `git log --name-only` with the GitHub
commit list to name each author by login. Commits with no login, and bots (`[bot]`, Dependabot, Renovate), are
dropped. `CHANGED {commits, last_at}` counts commits per author per file. When the stage succeeds it replaces every
`OWNS` and `CHANGED` edge, since neither carries `snapshot_sha`; when git, the network, or the parse fails it is
skipped with a `people` warning and the previous edges stay.

**6. Prune and stamp (T19).** Run only after stages 1 to 4 succeed, as separate constants in this order. Deletes
are bounded with `WITH … LIMIT 5000` and repeated until a run returns 0. Change C6 adds `DECLARES` and `AFFECTS`,
and R27 adds `AT`.

```cypher
// prune.installs, then prune.files the same way
MATCH (n:Install) WHERE n.snapshot_sha <> $sha WITH n LIMIT 5000 DETACH DELETE n RETURN count(*) AS deleted
// prune.depends, then prune.imports, prune.loads, prune.declares, prune.affects, prune.at: one constant per type
MATCH ()-[e:DEPENDS_ON]->() WHERE e.snapshot_sha <> $sha WITH e LIMIT 5000 DELETE e RETURN count(*) AS deleted
// prune.fixed
MATCH (x:Finding) WHERE x.status IN ["open", "planned"] AND NOT (x)-[:AT]->(:Install)
SET x.status = "fixed", x.fixed_at = $now
// prune.stamp
MATCH (r:Repo {url: $url}) SET r.snapshot_sha = $sha, r.ingested_at = $now
```

Deleting an install also deletes the `TOUCHED` edges old steps hold to it, a known gap in
[architecture.md](../architecture.md#15-known-gaps).

## Failures

`IngestError extends Fault`; the worker maps `surface` to the HTTP answer and to the `job.failed` event that ends
the job's stream.

| Code | When | Surface code |
| --- | --- | --- |
| `ingest.missing` | GitHub answers 404 for the repository or the commit | `missing` |
| `ingest.manifest` | No root `package.json`, or it fails its schema | `unsupported` |
| `ingest.lockfile` | No `package-lock.json`, a version other than 2 or 3, or it fails its schema | `unsupported` |
| `ingest.upstream` | GitHub or OSV still failing after the adapter's retries | `upstream` |
| `ingest.aborted` | The signal fired | `internal` |

Graph errors propagate unchanged. Parse failures, unresolved specifiers, aliases, skipped files, range disagreements,
and stage 5 are warnings, never failures. A failure before stage 6 leaves the new commit's rows beside the old
ones with `Repo.snapshot_sha` unchanged; ingesting again at the same commit repairs it, because every write merges.

## Tests

FalkorDB is real; `Forge` and `Advisories` are recorded fixtures; `Clock` is fixed.

- Fetch: a recorded tarball keeps `src/a.ts` and drops `node_modules/x/index.js`, `dist/b.js`, `c.min.js`, a 600 KB
  source file, and a symlink, while a 1 MB lockfile is kept; a tarball with no lockfile fails `ingest.lockfile`, and
  one with `lockfileVersion: 1` fails the same way.
- Lockfile, on `fixtures/lockfiles/nested.json` (two copies of one package at different depths): `resolve` gives the
  nested copy to its parent and the root copy elsewhere; the `DEPENDS_ON` count equals the hand count; a `link`
  entry yields no install; `devOptional` sets `dev`; an unresolved regular dependency is one `unresolved` warning.
- Imports, one file per form under `fixtures/imports`: ESM, CommonJS, dynamic, re-export, `import x = require`,
  type-only (no edge), JSX, and a broken file (regex fallback, one `parse` warning); `./util.js` resolves to
  `util.ts`; `lodash/merge` keeps its specifier; `@/lib` is an `alias` warning; the classification and `is_entry`
  tables are each checked on a list of paths.
- Advisories, from S2's recorded OSV responses: `severity_rank` is written; a second ingest with an `Advisories`
  double that throws on any call succeeds within 24 hours and writes the same `Vuln` and `Finding` nodes.
- People: the last matching CODEOWNERS rule wins; `@acme/web` is a team; a bot's commits are absent; a failing
  history double gives one `people` warning and leaves the previous `OWNS` edges.
- Verification target: ingesting `fixtures/mini-repo` into `verify:t1` with an override whose `package.json`
  bumps one direct dependency writes that dependency's edited range on `DECLARES`, takes every install from the
  override lockfile, writes no `OWNS` or `CHANGED` edge, and leaves the repository graph's node count unchanged.
- Prune, ingesting `fixtures/mini-repo` at two commits: a dependency removed from `package.json` but still
  installed transitively loses its `DECLARES` (C6); a `Decision` and its `Finding` survive a moved install; a
  finding whose only install was upgraded in place ends `fixed` with the clock's time; re-ingest at the same commit
  leaves an identical ordered dump of the graph.
- End to end on demo repository one: G1 and G2 in [graph](graph.md#golden-queries) match.

## Open points

- The OSV chunk size is [D5](../plan.md#8-decisions).
- The worker should refuse runs on a repository whose last ingest failed until a re-ingest succeeds.
