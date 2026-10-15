# Review standard

This is the review a change is judged against before it merges into `main`. It is run as an independent pass — the
other owner, or a coding agent started in a fresh context with only this file, the engineering standard, and the
diff — because a reviewer unattached to the reasoning that produced the change catches what the author's context
hides. The job is not to approve; it is to find every bug, design flaw, broken contract, untested branch, hidden
assumption, and standards violation before the change reaches the demo. The reviewer is judged on what is missed.

Load and follow the [engineering standard](engineering.md) alongside this file. Read the diff and the files that own
the changed behaviour rather than the whole repository, and spend depth on the load-bearing paths: the tier query,
the planner, the executor and its verification, the agent loop's citation check, and anything under
[contracts](../../../contracts).

## Compliance comes before logic

Confirm the diff respects every P0 rule in [AGENTS.md](../../../AGENTS.md) before reviewing its logic, and raise a
violation as the first issue. These are automatic blockers: a vendor import in `packages/core`; an `any`; a boundary
value used without a zod parse; a graph name taken from a caller; a value concatenated into Cypher or an unbounded
variable-length pattern; anything that executes repository code; a boolean steering behaviour where a union belongs;
a compound or filler file or package name; and a log line that is not a structured event or that records a secret
or file content. Then confirm the specifics: dependencies point inward; every exported symbol carries a TSDoc
contract; no configuration is read below the composition root; and every changed area carries the tests the
engineering standard requires.

## Operating rules

Six rules govern how a claim is made, and each overrides a generic instinct where they conflict:

- **Proof before claim.** Never assert a bug, a fix, or a coverage gap without naming the exact `file:line`, test
  name, query, or graph state. No "this might be missing"; enumerate it and verify it.
- **Root cause only.** Reject a fix that addresses a symptom without explaining its mechanism. A tier that comes out
  wrong is traced to the lockfile walk, the import resolution, or the query, not patched in the report.
- **No heuristics on heuristics.** A substring or keyword branch steering a decision is debt; a new one is a blocker
  unless a structural alternative — a schema, a union, a dispatch table, a port — is proven impossible.
- **No fabricated reads.** Never claim to have read a file that was not read, and never treat a search that missed
  an expected keyword as proof of absence.
- **Stale-source check.** Confirm the reviewed files match the branch head, because an old read of rewritten code is
  how a false review ships.
- **Enumerated coverage.** "Tests pass" is not a review signal. For every changed function, list its branches by
  name and, for each, the test that exercises it, or mark it missing.

## Demo-path checks

Because the system is judged through a live demo and a recorded video, a reviewer also confirms, for any change on
the demo path: the change keeps every tool result inside the `ToolResult` envelope with real evidence ids; a Step
node is written for success and for failure; a recorded run still replays with no model call; the funnel numbers
still come from `summary` and agree with the tool results; and the pull request action still requires approval.

## Output

For every issue, state its severity — `Blocker`, `Critical`, `Major`, `Minor`, or `Suggestion` — and its category,
describe it in at most two sentences naming `file:line`, explain in at most three sentences why it is a problem, and
recommend the structural fix. Give a short example only when the fix is not obvious.

Close with a verdict of `Approve with minor changes`, `Request changes`, or `Block`. Rate production readiness,
testing confidence, and demo risk each from one to ten, state whether standard compliance passes, passes with minor
deviations, or fails, and summarise in three to five sentences whether the right problem was solved, whether the fix
is structural, whether the testing is enumerable, and any blocker by name.
