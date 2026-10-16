export { GitHub } from "./adapters/github.ts";
export { GitHistory, HistoryError } from "./adapters/history.ts";
export { type IngestCode, IngestError } from "./errors.ts";
export { entries, type FileKind, kind } from "./parse/classify.ts";
export { Codeowners } from "./parse/codeowners.ts";
export { type Found, imports as specifiers } from "./parse/imports.ts";
export { type Entry, Lock } from "./parse/lock.ts";
export { Manifest } from "./parse/manifest.ts";
export { FETCH_LIMITS, repoUrl, type Snapshot, snapshot, type Target } from "./stages/fetch.ts";
export {
  bare,
  type Graph,
  graph,
  imports,
  load,
  relative,
  type Target as Resolved,
} from "./stages/imports.ts";
export { lockfile, resolve, type Tree, tree } from "./stages/lockfile.ts";
export { HISTORY_COMMITS, people, tally } from "./stages/people.ts";
