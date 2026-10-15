# `packages/planner`

`packages/planner` finds the cheapest set of upgrades that clears the findings a run asks about. It reads the
affected installs and their dependency chains from the graph, asks the npm registry which versions exist and what
they depend on, builds three kinds of candidate upgrade, and chooses among them with a greedy weighted set cover.
Its single responsibility is a deterministic plan: the same graph and the same registry data give a byte-identical
result, because the model explains the plan and never chooses it.

| Owner | Tasks | Layer | Depends on |
| --- | --- | --- | --- |
| Shaukat Ali | T14 | Core (`src/solve`) and application (the rest) | `@noderunner/core`, `@noderunner/graph/cypher`, `semver` |

## Responsibility

It owns target loading, packument prefetch within a call budget, candidate generation, merging, the set cover,
conflict resolution, the plan write, and the npm `Registry` adapter with its cache. It does not set tiers (that is
`reachability`), edit `package.json` or regenerate a lockfile (that is the [executor](executor.md)), or name
reviewers (`owners_for`). `plan_upgrades` in [tools](tools.md) is a thin wrapper that calls `plan` and builds the
evidence; its input and output are fixed by [tools.md](../../../contracts/mcp/tools.md).

The package is split so that the algorithm can be tested without a graph or a network:

```text
packages/planner/src/
  index.ts          plan(), PlanInput, PlanResult
  targets.ts        reads targets and chains through G (cypher/tools/plan.ts)
  fetch.ts          prefetches packuments through Registry within the budget
  write.ts          writes the plan in one query
  solve/            pure: imports only @noderunner/core and semver, enforced by noRestrictedImports
    candidates.ts   refresh, bump, and override candidates
    cover.ts        merge, greedy cover, conflicts
    jump.ts         semver jump of an upgrade
  adapters/npm.ts   Registry over registry.npmjs.org with a bounded memory cache and a disk cache
```

## Interface

```ts
function plan(g: G, input: PlanInput, deps: PlanDeps, signal: AbortSignal): Promise<PlanResult>;
type PlanInput = { runId: RunId; url: string; tiers: readonly Tier[]; majors: "allow" | "skip" };
type PlanDeps = { registry: Registry; ids: Ids; clock: Clock };
type PlanResult = { planId: PlanId; upgrades: readonly Upgrade[]; uncovered: readonly FindingKey[];
                    totalCost: number; unavailable: readonly string[] };   // packages the registry could not give

// solve/ — no I/O, no clock, no ids
function solve(targets: readonly Target[], packuments: ReadonlyMap<string, Packument>,
               majors: "allow" | "skip"): Solution;
type Target = { key: FindingKey; package: string; lockPath: LockPath; version: string;
                ranges: readonly OsvRange[]; parents: readonly string[];   // every range that selects this install
                chains: readonly Chain[] };
type Chain = { direct: string; version: string; path: readonly string[] }; // package names, direct first
type Solution = { upgrades: readonly Omit<Upgrade, "id">[]; uncovered: readonly FindingKey[]; totalCost: number };

// adapters/npm.ts
function npm(opts: { dir: string; fetch: typeof globalThis.fetch; clock: Clock }): Registry;
```

`plan_upgrades` maps the contract's `allowMajor: boolean` to `majors` at the tool boundary, so no boolean steers the
planner. `Registry` is the [core](core.md) port, `packument(name, signal): Promise<Packument | null>`, where
`Packument` is `{ name, versions: Record<version, { deps: Record<name, range> }> }`. One call returns every version
and its dependency ranges, which replaces the LLD's `versions` and `deps` pair and makes one call equal to one fetch;
`null` means the registry has no such package. `unavailable` is
not part of the tool's `data`; `plan_upgrades` uses it only in its summary line.

## Algorithm

1. **Targets.** `plan.targets` loads every `Finding` whose `tier` is in `tiers` and whose `status` is `open` or
   `planned`, so waived and fixed findings are never targets. A target is one `(finding, affected install)` pair,
   carrying the install's version, the finding's ranges from `Vuln.ranges` for its package (parsed with core's
   `OsvRange` schema), and `parents`: the range on every `DEPENDS_ON` into the install and the `DECLARES` range when
   it is direct. `plan.chains` adds each root chain of at most two hops below a direct dependency through a bounded
   named path, `MATCH p = (:Repo {url: $url})-[:DECLARES]->(d:Install)-[:DEPENDS_ON*1..2]->(bad)`, ordered and
   limited. A direct install is its own chain of length zero. Longer chains get no bump, only refresh or override,
   so the planner needs no `shortestPath` and does not wait on D1.
2. **Prefetch.** Targets are taken in key order; each needs the packuments of its package and of every package on
   its chains. A name is fetched once per plan. Each finding may charge at most 60 new fetches and the plan at most
   300; past either, the remaining names stay unfetched and the finding falls back to override, as in the LLD. A
   registry failure for a name records it in `unavailable` and the prefetch continues. Each fetch passes the
   call's signal, so the 20-second `timeoutMs` of `plan_upgrades` bounds a cold prefetch.
3. **Candidates**, each a predicate over targets, with `t = maxSatisfying(versions(q), range)`:
   - **refresh**, cost 1, one per package `q`: covers a target of `q` when every parent range gives a `t` that
     `isAffected` reports as unaffected. `to` is the lowest such `t`, `from` the lowest covered installed version.
   - **bump**, cost 2 for patch or minor and 5 for major, per chain: walk the direct dependency's stable versions
     above its current one in ascending order, at most 40, skipping majors when `majors` is `skip`. Take the first
     version whose range for the next package gives an unaffected `t` (one hop), or whose next package's `t` in
     turn gives one (two hops), or that no longer depends on the next package. For a direct `q`, take the first
     unaffected version outside its declared range. A bump covers a target only when the chain's last hop is the
     install's only parent; a shared install is left to refresh or override, because npm may keep the old copy
     for its other parents.
   - **override**, cost 4, per finding: `to` is the highest `lowestFixed(version, ranges)` over the finding's
     installs, and it covers all of them, since `overrides: { q: to }` pins every copy. If any install has no fix,
     the finding gets no override. The plan labels it a workaround.
4. **Merge.** Candidates of the same kind, package, and `to` are united; their covered targets are the union.
5. **Cover.** While some candidate covers an uncovered target, choose the one with the lowest
   `cost / newlyCovered`. Ties go to the lower semver jump, then the package name, then the kind (`refresh`,
   `bump`, `override`), then the lower `to`. This is a total order, so the result is deterministic.
6. **Conflicts.** When two chosen upgrades change the same package, keep the one with the higher `to` (on a tie the
   stronger kind: `override`, then `bump`, then `refresh`), re-test the dropped one's targets with the kept one's
   predicate, return any it does not cover to the pool, remove every other candidate for that package, and resume
   step 5. Each round removes at least one candidate, so the loop ends.
7. **Result.** A finding is closed when every one of its targets is covered. `Upgrade.closes` lists the closed
   findings it covers a target of, and `uncovered` lists every finding with an uncovered target, never dropping one.
   `semverJump` comes from `jump.ts`: `major` when `to` is outside `^from`, `minor` when outside `~from`, else
   `patch`, so `0.2.3` to `0.3.0` is major, as a caret range treats it.
8. **Write.** `write.ts` takes ids from `Ids` in selection order and the time from `Clock`, then runs one query, so
   a plan is written whole or not at all. A new plan is unapproved: `approved` is `false`, and `approved_by` and
   `approved_at` stay absent until `POST /plans/:id/approve` sets all three (R1).

```cypher
// plan.write
MATCH (run:Run {id: $runId})
CREATE (run)-[:PROPOSED]->(p:Plan {id: $planId, created_at: $now, total_cost: $totalCost, uncovered: $uncovered,
                                   approved: false})
WITH p
UNWIND $upgrades AS u
CREATE (p)-[:INCLUDES]->(x:Upgrade {id: u.id, kind: u.kind, package: u.package, from: u.from, to: u.to,
                                    semver_jump: u.semverJump, cost: u.cost})
WITH x, u
UNWIND u.closes AS key
MATCH (f:Finding {key: key})
CREATE (x)-[:CLOSES]->(f)
SET f.status = CASE WHEN f.status = "open" THEN "planned" ELSE f.status END
```

## Registry adapter and cache

`npm()` requests the abbreviated packument (`Accept: application/vnd.npm.install-v1+json`) and merges each version's
`dependencies`, `optionalDependencies`, and `peerDependencies` into `deps`, in that precedence. The response is
parsed with zod; a 404 is `null`. Responses are kept in a memory map of at most 2,000 names owned by the adapter
object, and on disk as `<CACHE_DIR>/registry/<encoded name>.json` with the fetch time. A disk entry younger than 24
hours is used without a request, and an older one is used when the request fails, so the demo works offline after
one warm run. At most eight requests run at once. Because the registry changes over time, determinism holds for
the same registry data, which the cache pins for a day.

## Failures

`PlannerError extends Fault`; `plan_upgrades` turns each into a `ToolErr` with the message shown.

| Code | When | Message to the model | Surface code |
| --- | --- | --- | --- |
| `planner.untiered` | No finding in the requested tiers has a tier yet | "Call reachability before plan_upgrades" | `invalid` |
| `planner.run` | The run node does not exist | "Unknown run" | `missing` |
| `planner.ranges` | `Vuln.ranges` fails its schema | "Advisory data is malformed; re-ingest" | `internal` |
| `registry.upstream` | The npm registry failed and no cached entry exists | none: recorded in `unavailable`, override used | `upstream` |

An empty target set is not an error: it yields a plan with no upgrades and a cost of 0. The signal aborts the
prefetch between fetches, and nothing is written unless `solve` finished.

## Tests

`solve` is tested with in-memory packuments built from recorded S2 responses; nothing is faked because it does no
I/O. Each case states its targets and asserts the exact upgrades, `uncovered`, and `totalCost`.

- Refresh possible: `qs@6.7.0` under `body-parser`'s `~6.7.0`, registry has `6.7.3` fixed: one refresh, cost 1.
- Bump, one hop: the parent range excludes every fix, and `express@4.21.2` asks for a fixed `body-parser`: one minor
  bump of `express`, cost 2. Bump, two hops: the fix is reached through an intermediate package's latest match.
- Major only: with `skip`, an override at cost 4; with `allow`, still the override for one finding, but a major bump
  at cost 5 when it closes two findings, since 2.5 per finding beats 4.
- Override only: no packuments available, so an override to `lowestFixed`. No fix at all: the finding is in
  `uncovered` and no upgrade is proposed.
- Two findings closed by one bump: one upgrade whose `closes` holds both keys.
- Shared install with two parents: no bump covers it; a refresh or override does.
- Tie-break: two candidates with equal ratio pick the lower jump, and at an equal jump the lower package name.
- Conflict: bumps of `express` to `4.18.2` and `4.21.2` keep `4.21.2` and re-test the dropped targets.
- Budget: a finding whose chains need 61 packuments falls back to override.
- Determinism: `JSON.stringify(solve(...))` is identical across two calls and across shuffled target order.

`plan` is tested against a real FalkorDB holding `fixtures/mini-repo`, with a `Registry` over recorded packuments
and fixed `Ids` and `Clock`. It writes one `Plan` with `approved: false` and `PROPOSED` from the run, the expected
`INCLUDES` and `CLOSES` edges, and `planned` statuses; a waived finding is neither planned nor uncovered; with no
tiers set it fails `planner.untiered` and writes nothing; a registry that fails for one name still yields a plan,
with that name in `unavailable`. `npm()` is tested against a local `node:http` server serving recorded
packuments: a cold call writes the disk entry, a second adapter with the server stopped answers from disk, and a 404
is `null`.

## Open points

- The contract's `allowMajor: boolean` sits awkwardly with the rule against steering booleans; it is mapped to
  `majors` at the tool boundary, and changing the contract is left to the owners.
- Three refinements of the LLD need the other owner's agreement: coverage counted per `(finding, install)` target
  rather than per finding; `maxSatisfying` rather than "admits an unaffected version", matching what a fresh
  install picks; and the single-parent rule for bumps. The plan-wide ceiling of 300 fetches is new.
- None of the open S1 and S2 decisions, [D1–D3 and D5](../plan.md#8-decisions),
  blocks the planner: chains use a bounded named path rather than `shortestPath`.
