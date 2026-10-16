import type { SemverJump } from "@noderunner/core";
import semver from "semver";

/** `major` when `to` is outside `^from`, `minor` when outside `~from`, else `patch`; 0.2.3 to 0.3.0 is major. */
export function jump(from: string, to: string): SemverJump {
  if (!semver.valid(from) || !semver.valid(to)) return "major";
  if (!semver.satisfies(to, `^${from}`)) return "major";
  if (!semver.satisfies(to, `~${from}`)) return "minor";
  return "patch";
}

/** Orders versions with semver where both are valid, and as text otherwise. */
export function compare(a: string, b: string): number {
  if (semver.valid(a) && semver.valid(b)) return semver.compare(a, b);
  return a < b ? -1 : a > b ? 1 : 0;
}
