# Demo video script

About three minutes, recorded on the local or hosted build against `nestjs/nest`. Every number below is from the live
gpt-5 run of 2026-10-17; re-read them from the screen on the day, since advisories change. Record at 1440×900 with the
browser at 110% zoom, and keep a replay (`?replay=1`) open in a second tab in case the live run is slow.

## Before recording

- [ ] FalkorDB up, worker and web running, `/healthz` all `true`
- [ ] `nestjs/nest` ingested at `c215fd9`; one finished run open in a tab for the fallback. **Do not re-ingest nest
      on the day**: its default branch has moved on, so a new ingest changes every number below and the eval's pin
- [ ] The fork `sakibalig/nest` exists and the token can write to it; the plan you will ship is approved but not shipped
- [ ] Browser: a clean profile, no extensions, bookmarks bar hidden, dev tools closed
- [ ] The NDSS paper and its 68% figure on a title card

## Shots

| # | Time | Screen | Narration |
| --- | --- | --- | --- |
| 1 | 0:00–0:20 | Title card: "68% of npm vulnerability alerts are noise — the vulnerable code is never reached." (NDSS 2026). Then a long `npm audit` output scrolling | "Your Node project has dozens of security alerts. Research at NDSS this year found two-thirds of them are noise: the vulnerable code is never reached. But nobody can tell which two-thirds." |
| 2 | 0:20–0:40 | Home page: paste `https://github.com/socketio/socket.io`, press Ingest; the six stages turn green in about 20 s. Then open the pre-loaded `nestjs/nest` | "Noderunner loads any npm repository into a FalkorDB graph: every file, every import, every installed package, the known vulnerabilities from OSV, and who owns each file. Here is NestJS, already loaded: 1,638 installed packages and 56 alerts." |
| 3 | 0:40–0:55 | Repository page: the funnel 56 → 10 → 10 → 0 | "Then it follows the graph. Fifty-six alerts. Ten are reachable from production code. That's the list that matters." |
| 4 | 0:55–1:30 | Press **Run triage agent**; steps appear one by one; the report streams in | "A gpt-5 agent investigates. It chooses its own tools: list the alerts, check reachability, trace who introduced each package, plan the upgrades, find reviewers. Every tool call is a step stored in the graph." |
| 5 | 1:30–2:05 | Click citation **3** on the brace-expansion line of "Why these matter"; the page scrolls up and the graph lights `fastify-adapter.ts → @fastify/static → glob → minimatch → brace-expansion` and the socket.io chains; open "Show query" on step 3 | "Every sentence in the report cites the step behind it. Click a citation and you see the exact path through the graph, and the Cypher query that found it. No claim without a path." |
| 6 | 2:05–2:30 | Scroll to the plan table and reviewers | "The plan is computed, not guessed: three upgrades close all ten reachable alerts, two of them lockfile-only refreshes. And it names reviewers from CODEOWNERS and git history." |
| 7 | 2:30–2:45 | Approve the plan, press **Open pull request**; about 15 s later the pull request link appears with "10 of 10 targeted alerts closed, no new alerts"; open it on GitHub | "Before it opens anything, Noderunner regenerates the lockfile, re-ingests it into a fresh graph, and checks that every targeted alert is gone and nothing new is reachable. Then it opens the pull request, with the path for each alert in the description." |
| 8 | 2:45–3:00 | Architecture diagram from the README; the GitHub repo URL | "FalkorDB graph per repository, typed tools, a vendor-neutral LLM layer, all open source. Noderunner: dependency triage with a graph path behind every claim." |

If the fork is not ready, shot 7 falls back to the replay: open the run with `?replay=1`, "Runs live in the graph too,
so any run replays exactly." A plan ships once; to retake shot 7, start a new triage run and approve its plan.

Optional insert after shot 6, from `eval/results.md`: "Against an agent with the same model but only file search,
the graph agent finds 83% of reachable alerts to its 25%." Quote only those committed numbers.

## What to say if asked

- **Import-level, not function-level.** "Reachable" means production code loads the package; VulTracer (NDSS 2026)
  goes further, to function calls. Noderunner's contribution is the traceable agent, its memory, and the action.
- **Deterministic core.** Tiers and the upgrade plan come from code; the model chooses tools and writes the report,
  and the report is checked against the tool results before it is shown.
