import { type EvEdge, type Evidence, type EvNode, edgeKey, limits } from "@noderunner/core";

/** Collects evidence in the order a tool adds it, most relevant first, with each node and edge kept once. */
export class Collector {
  readonly #nodes = new Map<number, EvNode>();
  readonly #edges = new Map<number, EvEdge>();
  readonly #cypher = new Set<string>();

  node(node: EvNode): this {
    if (!this.#nodes.has(node.id)) this.#nodes.set(node.id, node);
    return this;
  }

  edge(edge: Omit<EvEdge, "key">): this {
    if (!this.#edges.has(edge.id))
      this.#edges.set(edge.id, { ...edge, key: edgeKey(edge.fromKey, edge.type, edge.toKey) });
    return this;
  }

  ran(text: string): this {
    this.#cypher.add(text);
    return this;
  }

  done(): Evidence {
    return { nodes: [...this.#nodes.values()], edges: [...this.#edges.values()], cypher: [...this.#cypher] };
  }
}

/** Keeps the first 300 nodes and 600 edges, dropping any edge whose endpoint was cut. */
export function cap(evidence: Evidence): { readonly evidence: Evidence; readonly dropped: number } {
  const nodes = evidence.nodes.slice(0, limits.evidenceNodes);
  const kept = new Set(nodes.map((node) => node.id));
  const joined = evidence.edges.filter((edge) => kept.has(edge.from) && kept.has(edge.to));
  const edges = joined.slice(0, limits.evidenceEdges);
  const dropped = evidence.nodes.length - nodes.length + (evidence.edges.length - edges.length);
  return { evidence: { nodes, edges, cypher: evidence.cypher }, dropped };
}
