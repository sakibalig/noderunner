import { type ErrorCode, Fault } from "@noderunner/core";

export type PlannerCode = "planner.untiered" | "planner.run" | "planner.ranges" | "registry.upstream";

const surfaces: Readonly<Record<PlannerCode, ErrorCode>> = {
  "planner.untiered": "invalid",
  "planner.run": "missing",
  "planner.ranges": "internal",
  "registry.upstream": "upstream",
};

/** A planning failure with a message safe to show a model. */
export class PlannerError extends Fault {
  readonly code: PlannerCode;
  readonly surface: ErrorCode;

  constructor(code: PlannerCode, message: string) {
    super(message);
    this.name = "PlannerError";
    this.code = code;
    this.surface = surfaces[code];
  }
}
