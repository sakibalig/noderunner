# Demo video script

About three minutes, recorded on the local or hosted build against `nestjs/nest`. Every number below is from the live
gpt-5 run of 2026-10-17; re-read them from the screen on the day, since advisories change. Record at 1440×900 with the
browser at 110% zoom, and keep a replay (`?replay=1`) open in a second tab in case the live run is slow.

## Before recording

- [ ] FalkorDB up, worker and web running, `/healthz` all `true`
- [ ] `nestjs/nest` ingested; one finished run open in a tab for the fallback
- [ ] Browser: a clean profile, no extensions, bookmarks bar hidden, dev tools closed
- [ ] The NDSS paper and its 68% figure on a title card

## Shots

| # | Time | Screen | Narration |
| --- | --- | --- | --- |
| 1 | 0:00–0:20 | Title card: "68% of npm vulnerability alerts are noise — the vulnerable code is never reached." (NDSS 2026). Then a long `npm audit` output scrolling | "Your Node project has dozens of security alerts. Research at NDSS this year found two-thirds of them are noise: the vulnerable code is never reached. But nobody can tell which two-thirds." |
| 2 | 0:20–0:40 | Home page: paste `https://github.com/nestjs/nest`, press Ingest; the six stages turn green | "Noderunner loads a repository into a FalkorDB graph: every file, every import, all 1,638 installed packages, the 56 known vulnerabilities from OSV, and who owns each file." |
| 3 | 0:40–0:55 | Repository page: the funnel 56 → 10 → 10 → 0 | "Then it follows the graph. Fifty-six alerts. Ten are reachable from production code. That's the list that matters." |
| 4 | 0:55–1:30 | Press **Run triage agent**; steps appear one by one; the report streams in | "A gpt-5 agent investigates. It chooses its own tools: list the alerts, check reachability, trace who introduced each package, plan the upgrades, find reviewers. Every tool call is a step stored in the graph." |
| 5 | 1:30–2:05 | Click citation **3** in the report; the graph zooms to the lit path `fastify-adapter.ts → @fastify/static → glob → minimatch → brace-expansion`; open "Show query" | "Every sentence in the report cites the step behind it. Click a citation and you see the exact path through the graph, and the Cypher query that found it. No claim without a path." |
| 6 | 2:05–2:30 | Scroll to the plan table and reviewers | "The plan is computed, not guessed: three upgrades close all ten reachable alerts, two of them lockfile-only refreshes. And it names reviewers from CODEOWNERS and git history." |
| 7 | 2:30–2:45 | Open the run with `?replay=1`; it replays with no model call | "Runs live in the graph too, so any run replays exactly — the agent's reasoning is data you can query." |
| 8 | 2:45–3:00 | Architecture diagram from the README; the GitHub repo URL | "FalkorDB graph per repository, typed tools, a vendor-neutral LLM layer, all open source. Noderunner: dependency triage with a graph path behind every claim." |

If T21 (the pull request) lands before recording, replace shot 7 with: approve the plan, the pull request opens on the
fork, and its description lists the path for each closed alert.

## What to say if asked

- **Import-level, not function-level.** "Reachable" means production code loads the package; VulTracer (NDSS 2026)
  goes further, to function calls. Noderunner's contribution is the traceable agent, its memory, and the action.
- **Deterministic core.** Tiers and the upgrade plan come from code; the model chooses tools and writes the report,
  and the report is checked against the tool results before it is shown.
