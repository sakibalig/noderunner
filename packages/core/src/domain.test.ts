import { describe, expect, it } from "vitest";
import type { StaleFacts } from "./domain.ts";
import { rank, staleness } from "./domain.ts";

describe("rank", () => {
  it("orders the five severities from critical down to unknown", () => {
    expect(["critical", "high", "moderate", "low", "unknown"].map((s) => rank(s as never))).toEqual([
      4, 3, 2, 1, 0,
    ]);
  });
});

describe("staleness", () => {
  const now = 1_000_000;
  const holding: StaleFacts = {
    decision: { kind: "waive", createdAt: 500_000, expiresAt: 2_000_000, tierAtDecision: "installed" },
    tier: "installed",
    advisoryModified: 400_000,
    severity: "high",
    others: ["moderate"],
  };

  it("holds while nothing has changed", () => {
    expect(staleness(holding, now)).toBeNull();
  });
  it("holds at the exact expiry instant", () => {
    expect(staleness({ ...holding, decision: { ...holding.decision, expiresAt: now } }, now)).toBeNull();
  });
  it("is expired one millisecond after expiry", () => {
    expect(staleness({ ...holding, decision: { ...holding.decision, expiresAt: now - 1 } }, now)).toBe(
      "expired",
    );
  });
  it("is now reachable when the tier rose", () => {
    expect(staleness({ ...holding, tier: "import-reachable" }, now)).toBe("now reachable");
  });
  it("counts a null tier at decision as not reachable", () => {
    const facts = {
      ...holding,
      tier: "import-reachable" as const,
      decision: { ...holding.decision, tierAtDecision: null },
    };
    expect(staleness(facts, now)).toBe("now reachable");
  });
  it("holds when the finding was already reachable when waived", () => {
    const facts = {
      ...holding,
      tier: "import-reachable" as const,
      decision: { ...holding.decision, tierAtDecision: "import-reachable" as const },
    };
    expect(staleness(facts, now)).toBeNull();
  });
  it("is advisory updated when the advisory changed after the decision", () => {
    expect(staleness({ ...holding, advisoryModified: 600_000 }, now)).toBe("advisory updated");
  });
  it("is worse vulnerability when a more severe one affects the same install", () => {
    expect(staleness({ ...holding, others: ["critical"] }, now)).toBe("worse vulnerability on same install");
  });
  it("takes the first matching rule", () => {
    const facts = {
      ...holding,
      tier: "import-reachable" as const,
      decision: { ...holding.decision, expiresAt: 1 },
    };
    expect(staleness(facts, now)).toBe("expired");
  });
  it("never marks an accept or reject stale", () => {
    expect(
      staleness({ ...holding, decision: { ...holding.decision, kind: "accept", expiresAt: 1 } }, now),
    ).toBeNull();
  });
});
