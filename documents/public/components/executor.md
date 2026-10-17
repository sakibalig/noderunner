# `packages/executor`

The executor turns an approved plan into a pull request on the team's fork, and checks its own work before it opens
anything. Its single responsibility is the action: edit `package.json`, regenerate the lockfile in a throwaway
sandbox, re-tier the result in a temporary graph, and only then push a branch, open the pull request, and record
`(:Plan)-[:SHIPPED_AS]->(:PullRequest)`. It is called only through the `open_pull_request` tool.

| Owner | Tasks | Layer | Depends on |
| --- | --- | --- | --- |
| Shaukat | T21, T22 | Application, with its `Forge` and `Sandbox` adapters | `packages/core` (domain, ports, `verifyName`, `limits`); `Db`, `ingest`, `Forge`, and `Sandbox`, injected by the composition root |

## Responsibility

It owns the eight steps below, the `package.json` edit rules, the sandbox command and its limits, the verification
comparison, the pull request description, and the `PullRequest` node. It is the only code that writes to a
repository, and the sandbox it drives is the only place where repository-derived content meets a process.

It holds every refusal check for a ship; `open_pull_request` in [tools](tools.md) delegates to it and checks
nothing itself. It does not decide what to upgrade (the [planner](planner.md) does), set the approval
(`POST /plans/:id/approve` in [worker](worker.md) sets `Plan.approved`, R1), emit events (the worker's shipment job
turns the result into `pr.opened`, `pr.refused`, or `job.failed`, R2), log, or parse a lockfile or tier a finding
itself: verification reuses the ingestion stages and the tier query, so the check and the original triage cannot
disagree on method. It never opens a pull request against any owner other than `PR_TARGET_OWNER`.

## Interface

`Forge`, `Change`, `Sandbox`, `Shipment`, and `Verification` are the [core](core.md) types, used unchanged; no
GitHub, Docker, or FalkorDB type appears in them. The executor calls only these port methods:

```ts
// from packages/core/src/ports — shown for reference, defined in core.md
interface Forge {
  read(repo: RepoRef, sha: Sha, path: string, signal: AbortSignal): Promise<string | null>;
  propose(repo: RepoRef, change: Change, signal: AbortSignal): Promise<{ url: string; number: number }>;
}
interface Sandbox {
  regenerate(files: { manifest: string; lock: string }, refresh: readonly string[], signal: AbortSignal):
    Promise<{ lock: string }>;
}
type Shipment =
  | { outcome: "opened"; url: string; branch: string; verification: Verification }
  | { outcome: "refused"; reason: "new reachable finding"; verification: Verification };
```

```ts
// packages/executor/src/index.ts
/** Re-ingests the repository at `repo.sha` into `verify:<runId>` with both package files replaced. */
export type Reingest = (repo: RepoRef & { sha: Sha }, override: { manifest: string; lock: string }, runId: RunId,
  signal: AbortSignal) => Promise<void>;
export type Deps = {
  readonly db: Db; readonly forge: Pick<Forge, "read" | "propose">; readonly sandbox: Sandbox;
  readonly clock: Clock; readonly reingest: Reingest;   // ingest, bound to its ports by the composition root
  readonly target: string;                              // PR_TARGET_OWNER
};
export type Opts = { readonly signal: AbortSignal; readonly onProgress: (p: Progress) => void };
export type Progress = { readonly step: "sandbox" | "verify"; readonly ms: number };

/** Steps 1 to 8 behind a per-plan lock taken before the first await. Throws `ExecutorError` for every failure below. */
export function shipper(deps: Deps): (req: { graph: GraphName; runId: RunId; planId: PlanId }, opts: Opts) =>
  Promise<Shipment>;

/** Pure: applies bumps and overrides by splicing only the changed values into the `package.json` text. */
export function edit(manifest: string, upgrades: readonly Pick<Upgrade, "kind" | "package" | "to">[]):
  { manifest: string; refresh: readonly string[] };

/** The plan as the pull request carries it; with a verification, the description reports it. */
export function draft(g: G, repoId: string, planId: string, signal: AbortSignal, verification?: Verification):
  Promise<PlanDraft | null>;
```

`Sandbox.regenerate` also receives `workspaces`, the `package.json` of each workspace the lockfile lists. The
separate `verify` entry point for the evaluation is not built; T24 does not need it.

`Forge.propose` hides the Git Data API: it creates the two blobs, a tree on `change.base`, a commit whose only
parent is `change.base`, and `refs/heads/<branch>` (moving the ref when it already exists), then opens the pull
request from `branch` into the fork's default branch with `change.title` and `change.body`. There is no logger in
`Deps`: core has no logger port, so `onProgress` and the returned value are what the worker logs.

## Behaviour

`ship` runs these steps in order, holding an in-process lock per plan id for its whole duration. It runs inside the
`open_pull_request` call, whose `timeoutMs` is 240 seconds (`limits.shipMs`, R3): up to 120 for the sandbox and the
rest for the verification ingest. That call belongs to a fixer run, or to the short `ui` run of the shipment job
that `POST /plans/:id/ship` starts (R2, R8).

1. **Load and refuse.** Load the `Plan`, its `Upgrade` nodes, and the `CLOSES` targets with `ship.load`
   (`cypher/tools/ship.ts`). Refuse with `unapproved` unless `Plan.approved` is true (R1), with `shipped` if the
   plan already has a `SHIPPED_AS` edge, and with `busy` if another ship of the plan holds the lock. Every refusal
   happens here, before any network call or file write.
2. **Fetch.** Read `package.json` and `package-lock.json` from the repository at `Repo.snapshot_sha` through
   `Forge.read`. A missing file is `missing`. Both are bounded: 1 MB for the manifest, 20 MB for the lockfile.
3. **Edit `package.json`.** Through `edit`, one rule per upgrade kind:
   - `bump`: for the direct dependency in `dependencies`, `devDependencies`, or `optionalDependencies`, keep the
     existing prefix and replace the version: `^4.17.1` becomes `^4.21.2`, `~4.17.1` becomes `~4.21.2`, and an
     exact `4.17.1` becomes `4.21.2`. The LLD's wording, "set `^<to>`, keeping the existing prefix style", is
     self-contradictory; this is the resolved rule. Any other range form (`>=`, `1.x`, `*`, a tag, `npm:` alias,
     git or file URL) is refused with `range`. `peerDependencies` is never edited.
   - `override`: set `overrides[<package>]` to the exact `to` version, creating `overrides` at the end of the
     object when absent. An existing nested override object for the package is refused with `range`.
   - `refresh`: no change to the manifest; the package name joins the `refresh` list for `npm update`.

   Only the changed values are spliced into the text (`jsonc-parser`), so indentation, line endings, inline arrays,
   key order, and the final newline are kept byte for byte.
4. **Regenerate the lockfile** with `Sandbox.regenerate({ manifest, lock }, refresh, signal)` (below). The returned
   `lock` must parse as JSON with `lockfileVersion` 2 or 3.
5. **Verify** into `verify:<runId>`, a name built by `verifyName` in core, never taken from a caller (R6):
   - Run a full ingest of the repository at `Repo.snapshot_sha` with target
     `{ kind: "verify", runId, override: { manifest, lock } }`, the edited `package.json` and the regenerated
     lockfile, so every file, import, `LOADS`, `DECLARES`, and `AFFECTS` edge is derived afresh from the same source
     files the repository graph was built from ([ingest](ingest.md#interface)). Then run the tier query
     (`tier.reachable`, the constant `reachability` runs) on that graph.
   - Compare, by finding key, with `ship.keys`: `targeted` counts the plan's `CLOSES` targets; `stillOpen` lists
     the targets that still have an `AT` edge in the verification graph; `closed` is `targeted` minus that list's
     length; and `newFindings` lists every key with an `AT` edge in the verification graph and none in the
     repository graph.
   - Drop `verify:<runId>` in `finally`, on success and on failure.
6. **Refuse on regression.** If any key in `newFindings` is `import-reachable`, return
   `{ outcome: "refused", reason: "new reachable finding", verification }` and stop (R4). Nothing is pushed, and the
   shipment job emits `pr.refused` with the verification
   ([C8](../plan.md#3-changes-from-the-lld)). Findings still open, and new
   findings in other tiers, do not block; they are reported in the description.
7. **Propose.** The fork is `PR_TARGET_OWNER/<repo name>`; any other target is refused. Call `Forge.propose` with a
   `Change` whose `base` is `snapshot_sha`, whose `branch` is `noderunner/plan-<last 8 characters of the plan id>`,
   whose two `files` are the edited `package.json` and the regenerated `package-lock.json`, and whose `body` is the
   description below. If the ref exists and the plan is unshipped, a previous attempt failed after the push, and the
   adapter moves the ref to the new commit.
8. **Record.** `ship.record`: `MERGE (:PullRequest {url})` with `number`, `branch`, `state: "open"`, `targeted`,
   `closed`, and `new_findings` (keys), and `(:Plan)-[:SHIPPED_AS]->(:PullRequest)`, in one query. `Finding.status`
   is not written: the plan's findings stay `planned` while the pull request is open, and a later ingest of the
   default branch sets them `fixed`. Return `{ outcome: "opened", url, branch, verification }`.

`onProgress` reports the sandbox and verification durations, from which the worker logs
`executor.sandbox.finished` and `executor.verify.finished`; it logs `executor.ship.started` before the call and
`executor.pr.opened`, `executor.pr.refused`, or `executor.ship.failed` from its outcome, each with `runId` and
`planId`. None carries file content, advisory text, or the token.

### The sandbox

The sandbox is the only place repository-derived content meets a process, so its limits are the security boundary.
`Sandbox.regenerate` is implemented by the Docker adapter, `adapters/docker.ts`. It writes the two files into a
fresh `mkdtemp` folder with mode `0700` and runs, through `spawn` with an argument array and no shell:

```sh
docker run --rm --name noderunner-<runId> --network bridge --memory 768m --cpus 1 --pids-limit 256 \
  --read-only --tmpfs /tmp --cap-drop ALL --security-opt no-new-privileges --user <uid>:<gid> \
  -e npm_config_cache=/tmp/npm -v <folder>:/w -w /w noderunner-sandbox:1 lock -- <refresh names...>
```

`lock` is a fixed script in the image (`docker/sandbox/Dockerfile`, Node 22 on a pinned digest) that runs
`npm install --package-lock-only --ignore-scripts --no-audit --no-fund` and then, when names are given,
`npm update --package-lock-only --ignore-scripts --no-audit --no-fund -- "$@"`. The LLD's
`sh -c "... $REFRESH_PKGS"` interpolated package names from the lockfile into a shell string; names are now
positional arguments to the fixed script, with no shell, each also checked against npm's package name grammar before
the call (R24). The flags `--rm`, `--memory 768m` (R25, below the LLD's `1g` so that a 2 GB worker host keeps
headroom), `--cpus 1`, `--read-only`, `--tmpfs /tmp`, the two-file mount, and `--ignore-scripts` MUST hold; the
others SHOULD. `--user` is the worker's own non-root id, so the container can write the mounted folder and nothing
else. The folder holds no `.npmrc`, so the registry is the public default. The run is killed with `docker kill`
after 120 seconds or on abort, and the folder is removed in `finally`.

**As built (D14, local hosting).** `Npm` in `adapters/npm.ts` runs the same two npm commands as a child process:
`spawn` with an argument array and no shell, in a fresh `mkdtemp` folder, with an environment of only `PATH`, `HOME`
(the folder), and the npm cache, killed after 120 seconds or on abort, and removed in `finally`. The folder holds the
edited `package.json`, the lockfile, and the `package.json` of every workspace the lockfile lists (paths checked to
stay inside the folder), so npm keeps the workspace entries; no other repository file is written. When strict peer
resolution fails, as it does for `nestjs/nest`, both commands are retried once with `--legacy-peer-deps`. An
override of a package that is also a direct dependency is written as `$<name>`, npm's reference to the root's own
spec, because npm refuses any other value (`EOVERRIDE`); when the root spec starts below the fixed version it is
refused with `range`.

`--network bridge` lets npm reach any destination, not only the registry; that egress is recorded as a known gap in
[architecture.md](../architecture.md#15-known-gaps) (R25), and `--ignore-scripts` with the absence of repository
code is what keeps regeneration safe. Where the sandbox runs on the hosted build, which has no Docker daemon, is
open as [D14](../plan.md#8-decisions); the recommended answer is a second
`Sandbox` adapter that runs the same npm commands as an unprivileged child process in a temporary folder holding
only the two files, with the same argument passing and limits that a child process can hold.

### The pull request description

Built by `describe` from graph data only: finding keys, severities, file paths, lock paths, and handles. Advisory
summaries and commit text are not copied in. Paths and names are rendered inside code spans, and the body is capped
at 60,000 characters by truncating the "why" list with a count of omitted rows. The headline says "reachable" only
when every targeted finding is `import-reachable`, and "targeted" otherwise.

```md
## Noderunner: close {closed} of {targeted} reachable vulnerabilities

| Upgrade | Closes | Risk |
|---|---|---|
| express 4.17.1 → 4.21.2 | GHSA-…, GHSA-… | minor |

### Why these alerts matter
- **GHSA-…** (high) in `qs@6.7.0`: `src/server.ts` → express → body-parser → qs

### Verification
Re-ingested the new lockfile: {closed}/{targeted} closed, {new} new findings.

### Not touched
{n} dev-only and {m} installed-but-not-imported alerts. Waived: {list with reasons}.

Reviewers suggested from CODEOWNERS and recent history: @…
```

## Failures

`ExecutorError extends Fault` from [core](core.md), with a dotted `code` and a `surface` code from
[errors.json](../../../contracts/api/errors.json). `open_pull_request` turns it into a `ToolErr` with the safe
message; the shipment job ends its stream on the surface code. Faults from `ingest` and the graph during
verification propagate with their own surface codes.

| Executor code | When | Surface code |
| --- | --- | --- |
| `executor.unapproved` | `Plan.approved` is not true (R1) | `unapproved` (403) |
| `executor.shipped` | The plan already has `SHIPPED_AS` | `shipped` (409) |
| `executor.busy` | Another ship of the same plan holds the lock | `busy` (409, retryable) |
| `executor.missing` | The plan, a manifest file, the fork, or the base commit in the fork does not exist | `missing` (404) |
| `executor.range` | A bump meets a range form outside `^x`, `~x`, or exact `x`, or an override meets a nested override | `range` (422, R21) |
| `executor.sandbox` | npm exits non-zero, the 120-second limit passes, or the output is not a v2 or v3 lockfile | `upstream` (502, retryable, R21) |
| `executor.forge` | GitHub refuses or fails a read, a push, or the pull request | `upstream` (502, retryable) |
| `executor.verify` | The verification graph cannot be queried after the ingest succeeded | `internal` (500) |

A regression is not an error: `ship` returns `{ outcome: "refused", … }`, `open_pull_request` returns it as
successful data (R4), and the shipment job ends in `pr.refused` with the verification. The ship route answers
`unapproved` or `shipped` up front, before it starts a job; if `unapproved`, `shipped`, or `busy` is raised inside
the job, the stream ends in `pr.refused` with `verification: null`, as [events.md](../../../contracts/api/events.md)
requires. Every other fault ends it in `job.failed` with the surface code (R2).

## Tests

FalkorDB is real. `Forge` and `Sandbox` are fakes backed by recorded files: the fake forge serves recorded manifests
and holds proposed branches and pull requests in memory; the fake sandbox returns a recorded regenerated lockfile.
`ingest` is the real package over recorded `Forge` and `Advisories` fixtures.

- `edit`: `^4.17.1` to `^4.21.2`; `~` kept; exact kept; a dependency in `devDependencies`; two-space, four-space,
  and tab indentation preserved byte for byte outside the changed value; key order kept; missing final newline kept
  missing; `overrides` created at the end; an existing string override replaced; `>=1.0.0` refused with `range`; a
  refresh leaves the manifest identical and lists the name.
- `ship` on `fixtures/mini-repo` with a plan whose `approved` is `false`: `unapproved`, the fake forge holds no
  branch, and no `verify:` graph exists afterwards.
- `ship` on a plan with `SHIPPED_AS`: `shipped`, and the graph has still exactly one `PullRequest` for it.
- Verification closes every target: `{ targeted: 2, closed: 2, stillOpen: [], newFindings: [] }`, a branch named
  `noderunner/plan-…` whose change holds exactly the two package files with base `snapshot_sha`, a `SHIPPED_AS`
  edge, the plan's findings still `planned`, and a description matching the checked-in snapshot.
- Verification uses both overridden files: after a bump, the verification graph's `DECLARES` range for the bumped
  dependency is the edited one, and an install the new lockfile drops is absent from it.
- Verification with a recorded lockfile that introduces a reachable install: `{ outcome: "refused" }`, the key in
  `newFindings`, no branch, no `PullRequest` node, and `Db.list()` holds no `verify:` graph.
- One target still open and one new `dev-only` finding: the pull request opens and the description reports both.
- The fake sandbox throws: `sandbox`, and the verification graph and temporary folder are gone.
- Two concurrent `ship` calls for one plan: one opens, the other fails with `busy`.
- Docker adapter argument builder: a refresh name `x; rm -rf /` is rejected before spawning; the argument array
  carries every limit flag above, including `--memory 768m`, and no `sh`. An opt-in test against real Docker
  regenerates the mini-repo lockfile offline from a recorded registry cache and checks that a `postinstall` script in
  a dependency did not run.

## Open points

Decisions are tracked in the [delivery plan](../plan.md#8-decisions).

- **D14.** Where the sandbox runs on the hosted build; see [the sandbox](#the-sandbox) and [deploy](deploy.md).
- **D15.** Whether any visitor to the hosted build may approve and ship; the recommended passphrase gate sits in
  front of `POST /plans/:id/approve` and `ship` in [worker](worker.md), and changes nothing here.
- **D9** (proposed). The UI's ship route calls `open_pull_request` in a `ui` run when no fixer runs.
- **`// VERIFY`:** `npm update <name> --package-lock-only` updates a transitive package wherever it appears; npm
  rejects an override that conflicts with a direct dependency's spec (`EOVERRIDE`).
