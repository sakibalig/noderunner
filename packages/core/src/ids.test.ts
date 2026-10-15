import { describe, expect, it } from "vitest";
import type { RunId } from "./ids.ts";
import { findingKey, graphName, parseFindingKey, purl, verifyName } from "./ids.ts";

describe("graphName", () => {
  it("lowercases owner and name into a repo graph", () => {
    expect(graphName({ owner: "Acme", name: "API" })).toBe("repo:acme/api");
  });
  it("rejects an owner outside the safe character set", () => {
    expect(() => graphName({ owner: "a}b", name: "api" })).toThrow();
  });
  it("rejects a traversal in the name", () => {
    expect(() => graphName({ owner: "acme", name: "../x" })).toThrow();
  });
});

describe("verifyName", () => {
  it("lowercases the run id", () => {
    expect(verifyName("01JQZ8ABCDEFGHJKMNPQRSTVWX" as RunId)).toBe("verify:01jqz8abcdefghjkmnpqrstvwx");
  });
});

describe("findingKey", () => {
  it("round-trips through parseFindingKey", () => {
    const key = findingKey("GHSA-hrpp-h998-j3pp", "@babel/core");
    expect(parseFindingKey(key)).toEqual({ vulnId: "GHSA-hrpp-h998-j3pp", pkg: "@babel/core" });
  });
  it("rejects a part containing a pipe", () => {
    expect(() => findingKey("GHSA-1|2", "qs")).toThrow();
  });
  it("rejects an empty package", () => {
    expect(() => findingKey("GHSA-1", "")).toThrow();
  });
});

describe("purl", () => {
  it("encodes a scope and a name separately", () => {
    expect(purl("@babel/core", "7.24.0")).toBe("pkg:npm/%40babel/core@7.24.0");
  });
  it("leaves an unscoped name as it is", () => {
    expect(purl("qs", "6.7.0")).toBe("pkg:npm/qs@6.7.0");
  });
});
