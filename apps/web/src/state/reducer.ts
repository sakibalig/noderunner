import type { ErrorCode, EvEdge, Evidence, EvNode, RunEvent, Verification } from "@noderunner/core";

export const GRAPH_NODES = 400;

export type StepView = Readonly<{
  stepId: string;
  seq: number;
  tool: string;
  input: unknown;
  outcome:
    | { readonly kind: "running" }
    | {
        readonly kind: "finished";
        readonly ok: boolean;
        readonly summary: string;
        readonly evidence: Evidence;
        readonly ms: number;
      };
}>;

export type RunViewState = Readonly<{
  steps: Readonly<Record<string, StepView>>;
  order: readonly string[];
  report: string;
  model: string | null;
  selected: { readonly kind: "step"; readonly id: string } | null;
  highlight: { readonly nodes: ReadonlySet<string>; readonly edges: ReadonlySet<string> };
  graph: { readonly nodes: readonly EvNode[]; readonly edges: readonly EvEdge[]; readonly dropped: number };
  mode: "live" | "replay";
  phase:
    | { readonly kind: "running" }
    | {
        readonly kind: "finished";
        readonly status: "done" | "failed" | "capped";
        readonly unverified: boolean;
      };
  ship:
    | { readonly kind: "none" }
    | { readonly kind: "opened"; readonly url: string; readonly verification: Verification }
    | { readonly kind: "refused"; readonly reason: string; readonly verification: Verification | null }
    | { readonly kind: "failed"; readonly code: ErrorCode; readonly message: string };
}>;

export type ViewAction = { readonly type: "select"; readonly stepId: string } | { readonly type: "clear" };

const none = { nodes: new Set<string>(), edges: new Set<string>() };

export function initial(mode: RunViewState["mode"]): RunViewState {
  return {
    steps: {},
    order: [],
    report: "",
    model: null,
    selected: null,
    highlight: none,
    graph: { nodes: [], edges: [], dropped: 0 },
    mode,
    phase: { kind: "running" },
    ship: { kind: "none" },
  };
}

/** Adds evidence to the union by stable key; past the node cap, new nodes and their edges are counted, not drawn. */
function merge(graph: RunViewState["graph"], evidence: Evidence): RunViewState["graph"] {
  const nodes = new Map(graph.nodes.map((n) => [n.key, n]));
  let dropped = graph.dropped;
  for (const node of evidence.nodes) {
    if (nodes.has(node.key)) continue;
    if (nodes.size >= GRAPH_NODES) dropped += 1;
    else nodes.set(node.key, node);
  }
  const edges = new Map(graph.edges.map((e) => [e.key, e]));
  for (const edge of evidence.edges)
    if (!edges.has(edge.key) && nodes.has(edge.fromKey) && nodes.has(edge.toKey)) edges.set(edge.key, edge);
  return { nodes: [...nodes.values()], edges: [...edges.values()], dropped };
}

function highlightOf(step: StepView | undefined): RunViewState["highlight"] {
  if (step?.outcome.kind !== "finished") return none;
  return {
    nodes: new Set(step.outcome.evidence.nodes.map((n) => n.key)),
    edges: new Set(step.outcome.evidence.edges.map((e) => e.key)),
  };
}

/** Pure: no clock, no I/O. Repeated step events replace rather than duplicate, so a reconnect is harmless. */
export function reducer(state: RunViewState, event: RunEvent | ViewAction): RunViewState {
  switch (event.type) {
    case "select":
      return {
        ...state,
        selected: { kind: "step", id: event.stepId },
        highlight: highlightOf(state.steps[event.stepId]),
      };
    case "clear":
      return { ...state, selected: null, highlight: none };
    case "run.started":
      // A replay or a reconnect after a restart starts over from here.
      return { ...initial(state.mode), model: event.model };
    case "step.started": {
      const known = state.steps[event.stepId] !== undefined;
      const step: StepView = {
        stepId: event.stepId,
        seq: event.seq,
        tool: event.tool,
        input: event.input,
        outcome: { kind: "running" },
      };
      const order = known ? state.order : [...state.order, event.stepId];
      return { ...state, steps: { ...state.steps, [event.stepId]: step }, order };
    }
    case "step.finished": {
      const prior = state.steps[event.stepId];
      const step: StepView = {
        stepId: event.stepId,
        seq: prior?.seq ?? state.order.length + 1,
        tool: prior?.tool ?? "unknown",
        input: prior?.input ?? null,
        outcome: {
          kind: "finished",
          ok: event.ok,
          summary: event.summary,
          evidence: event.evidence,
          ms: event.ms,
        },
      };
      const order = prior === undefined ? [...state.order, event.stepId] : state.order;
      return {
        ...state,
        steps: { ...state.steps, [event.stepId]: step },
        order,
        graph: merge(state.graph, event.evidence),
      };
    }
    case "message.delta":
      return { ...state, report: state.report + event.text };
    case "run.finished":
      return {
        ...state,
        report: event.report,
        phase: { kind: "finished", status: event.status, unverified: event.unverified },
      };
    case "pr.opened":
      return { ...state, ship: { kind: "opened", url: event.url, verification: event.verification } };
    case "pr.refused":
      return { ...state, ship: { kind: "refused", reason: event.reason, verification: event.verification } };
    case "job.failed":
      return { ...state, ship: { kind: "failed", code: event.code, message: event.message } };
    default:
      return state;
  }
}
