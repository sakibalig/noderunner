import type { RunViewState } from "./reducer.ts";

export type Element = {
  readonly group: "nodes" | "edges";
  readonly data: Readonly<Record<string, string>>;
  readonly classes: string;
};

/** Left-to-right rank per label, so a path reads File → Install → Vuln. */
const ranks: Readonly<Record<string, number>> = {
  File: 0,
  Package: 1,
  Install: 2,
  Vuln: 3,
  Finding: 4,
  Person: 0,
  Upgrade: 3,
};

/** Cytoscape elements for the evidence union; ids are stable keys, classes mark the highlighted path. */
export function elements(
  graph: RunViewState["graph"],
  highlight: RunViewState["highlight"],
): readonly Element[] {
  const lit = highlight.nodes.size > 0 || highlight.edges.size > 0;
  const mark = (on: boolean) => (lit ? (on ? "on" : "dim") : "");
  const nodes: Element[] = graph.nodes.map((node) => {
    const severity = typeof node.props?.severity === "string" ? node.props.severity : "";
    return {
      group: "nodes",
      data: {
        id: node.key,
        name: short(node.name),
        label: node.label,
        rank: String(ranks[node.label] ?? 2),
        severity,
      },
      classes: [node.label.toLowerCase(), severity, mark(highlight.nodes.has(node.key))]
        .filter(Boolean)
        .join(" "),
    };
  });
  const edges: Element[] = graph.edges.map((edge) => ({
    group: "edges",
    data: { id: edge.key, source: edge.fromKey, target: edge.toKey, type: edge.type },
    classes: mark(highlight.edges.has(edge.key)),
  }));
  return [...nodes, ...edges];
}

/** `node_modules/a/node_modules/b` reads as `b`; long names keep their last 28 characters. */
export function short(name: string): string {
  const tail = name.includes("node_modules/") ? name.slice(name.lastIndexOf("node_modules/") + 13) : name;
  return tail.length > 28 ? `…${tail.slice(-27)}` : tail;
}

export const stylesheet = [
  {
    selector: "node",
    style: {
      label: "data(name)",
      "font-size": 9,
      "text-background-color": "#fbfaf6",
      "text-background-opacity": 0.85,
      "text-background-padding": "2px",
      "font-family": "ui-monospace, Menlo, monospace",
      color: "#1c1b18",
      "text-valign": "bottom",
      "text-margin-y": 4,
      width: 22,
      height: 22,
      "background-color": "#c9c4b6",
      "border-width": 0,
      "transition-property": "opacity, background-color",
      "transition-duration": 200,
    },
  },
  { selector: "node.file", style: { shape: "round-rectangle", "background-color": "#8a8679" } },
  { selector: "node.install", style: { shape: "ellipse", "background-color": "#c48a1c" } },
  { selector: "node.package", style: { shape: "round-rectangle", "background-color": "#d9b45a" } },
  {
    selector: "node.vuln",
    style: { shape: "diamond", width: 26, height: 26, "background-color": "#b4451f" },
  },
  { selector: "node.vuln.critical", style: { "background-color": "#8f1d1d" } },
  { selector: "node.finding", style: { shape: "tag", "background-color": "#b4451f" } },
  { selector: "node.person", style: { shape: "ellipse", "background-color": "#5b7a99" } },
  {
    selector: "edge",
    style: {
      width: 1.5,
      "line-color": "#d6d1c4",
      "target-arrow-color": "#d6d1c4",
      "target-arrow-shape": "triangle",
      "arrow-scale": 0.8,
      "curve-style": "bezier",
      "transition-property": "opacity, line-color",
      "transition-duration": 200,
    },
  },
  { selector: ".dim", style: { opacity: 0.15 } },
  { selector: "node.on", style: { "border-width": 3, "border-color": "#b4451f", opacity: 1 } },
  {
    selector: "edge.on",
    style: {
      width: 3,
      "line-color": "#b4451f",
      "target-arrow-color": "#b4451f",
      opacity: 1,
      label: "data(type)",
      "font-size": 8,
      color: "#b4451f",
    },
  },
];
