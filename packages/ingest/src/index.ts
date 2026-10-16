export { GitHub } from "./adapters/github.ts";
export { GitHistory, HistoryError } from "./adapters/history.ts";
export { type IngestCode, IngestError } from "./errors.ts";
export { Codeowners } from "./parse/codeowners.ts";
export { type Entry, Lock } from "./parse/lock.ts";
export { Manifest } from "./parse/manifest.ts";
export { FETCH_LIMITS, repoUrl, type Snapshot, snapshot, type Target } from "./stages/fetch.ts";
export { HISTORY_COMMITS, people, tally } from "./stages/people.ts";
