import { describe, expect, it } from "vitest";
import { osvRecords } from "./fixtures/index.ts";
import type { OsvRange } from "./range.ts";
import { isAffected, lowestFixed, rangesFor, severityOf } from "./range.ts";

const lodash = rangesFor(osvRecords.lodash, "lodash");
const qs = rangesFor(osvRecords.qs, "qs");
const template = rangesFor(osvRecords.lodash, "lodash.template");

describe("rangesFor", () => {
  it("collects every affected entry for one package", () => {
    expect(qs).toHaveLength(9);
  });
  it("ignores entries from another ecosystem", () => {
    expect(rangesFor(osvRecords.lodash, "lodash-rails")).toEqual([]);
  });
});

describe("isAffected", () => {
  it.each([
    ["4.17.20", true],
    ["4.17.21", false],
    ["0.1.0", true],
  ])("lodash %s, introduced 0 and fixed 4.17.21, is %s", (version, expected) => {
    expect(isAffected(version, lodash)).toBe(expected);
  });

  it.each([
    ["6.7.0", true],
    ["6.7.3", false],
    ["6.10.2", true],
    ["6.10.3", false],
    ["6.2.3", true],
    ["6.2.4", false],
  ])("qs %s across nine disjoint ranges is %s", (version, expected) => {
    expect(isAffected(version, qs)).toBe(expected);
  });

  it("treats last_affected as inclusive", () => {
    expect(isAffected("4.5.0", template)).toBe(true);
    expect(isAffected("4.5.1", template)).toBe(false);
  });

  it("places a prerelease below its release", () => {
    expect(isAffected("4.17.21-rc.1", lodash)).toBe(true);
  });

  it("ignores GIT ranges", () => {
    const git: OsvRange[] = [{ type: "GIT", events: [{ introduced: "0" }] }];
    expect(isAffected("1.0.0", git)).toBe(false);
  });

  it("treats an unparseable version as not affected", () => {
    expect(isAffected("latest", lodash)).toBe(false);
  });

  it("keeps an interval with no end open", () => {
    const open: OsvRange[] = [{ type: "SEMVER", events: [{ introduced: "2.0.0" }] }];
    expect(isAffected("1.9.9", open)).toBe(false);
    expect(isAffected("9.0.0", open)).toBe(true);
  });
});

describe("lowestFixed", () => {
  it("returns the fix of the range the version sits in", () => {
    expect(lowestFixed("6.7.0", qs)).toBe("6.7.3");
  });
  it("skips a fix that a later range still affects", () => {
    expect(lowestFixed("6.2.3", qs)).toBe("6.2.4");
    const overlapping: OsvRange[] = [
      { type: "SEMVER", events: [{ introduced: "0" }, { fixed: "1.0.1" }] },
      { type: "SEMVER", events: [{ introduced: "1.0.1" }, { fixed: "1.0.2" }] },
    ];
    expect(lowestFixed("1.0.0", overlapping)).toBe("1.0.2");
  });
  it("returns null for a range closed only by last_affected", () => {
    expect(lowestFixed("4.0.0", template)).toBeNull();
  });
});

describe("severityOf", () => {
  it("reads the GitHub severity word", () => {
    expect(severityOf(osvRecords.qs)).toBe("high");
  });
  it("maps a missing word to unknown", () => {
    expect(severityOf({ ...osvRecords.qs, database_specific: undefined })).toBe("unknown");
  });
});
