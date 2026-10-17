import { describe, expect, it } from "vitest";
import { check, type LabelFile, reachable } from "./labels.ts";

const sha = "c".repeat(40);
const file: LabelFile = {
  repo: "acme/api",
  sha,
  labels: { "G-1|qs": "import-reachable", "G-2|ws": "dev-only" },
  corrections: [],
  checked: [],
};

describe("labels", () => {
  it("accepts labels for exactly the findings at the pinned commit", () => {
    expect(() => check("l.json", file, sha, ["G-1|qs", "G-2|ws"])).not.toThrow();
    expect([...reachable(file)]).toEqual(["G-1|qs"]);
  });

  it.each([
    ["another commit", "d".repeat(40), ["G-1|qs", "G-2|ws"], "pins"],
    ["a finding without a label", sha, ["G-1|qs", "G-2|ws", "G-3|x"], "no label for G-3|x"],
    ["a label for no finding", sha, ["G-1|qs"], "labels G-2|ws"],
  ])("stops on %s, naming the file and key", (_, pinned, keys, message) => {
    expect(() => check("l.json", file, pinned, keys)).toThrow(message);
  });
});
