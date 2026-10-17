"use client";

import type { Core, ElementDefinition, StylesheetJson } from "cytoscape";
import { useEffect, useRef } from "react";
import { elements, stylesheet } from "../state/canvas.ts";
import type { RunViewState } from "../state/reducer.ts";

type Props = {
  readonly graph: RunViewState["graph"];
  readonly highlight: RunViewState["highlight"];
};

const layout = {
  name: "dagre",
  rankDir: "LR",
  nodeSep: 18,
  rankSep: 70,
  animate: true,
  animationDuration: 300,
  fit: true,
  padding: 24,
};

/**
 * The evidence graph: only nodes the run touched, never the whole repository. The layout reruns when nodes are
 * added, so the graph grows as steps finish; a selection only changes classes.
 */
export function Canvas({ graph, highlight }: Props) {
  const box = useRef<HTMLDivElement>(null);
  const cy = useRef<Core | null>(null);
  const drawn = useRef(0);
  const focused = useRef("");

  useEffect(() => {
    let alive = true;
    void (async () => {
      const [{ default: cytoscape }, { default: dagre }] = await Promise.all([
        import("cytoscape"),
        import("cytoscape-dagre"),
      ]);
      if (!alive || box.current === null) return;
      cytoscape.use(dagre);
      cy.current = cytoscape({
        container: box.current,
        style: stylesheet as unknown as StylesheetJson,
        minZoom: 0.2,
        maxZoom: 2.5,
      });
      drawn.current = 0;
    })();
    return () => {
      alive = false;
      cy.current?.destroy();
      cy.current = null;
    };
  }, []);

  useEffect(() => {
    const instance = cy.current;
    if (instance === null) return;
    const wanted = elements(graph, highlight) as unknown as ElementDefinition[];
    instance.batch(() => {
      for (const element of wanted) {
        const existing = instance.getElementById(element.data.id ?? "");
        if (existing.nonempty()) existing.classes(element.classes ?? "");
        else instance.add(element);
      }
    });
    const count = instance.nodes().length;
    const grew = count !== drawn.current;
    if (grew) {
      drawn.current = count;
      instance.layout(layout).run();
    }
    // Zoom to the selected step's path; a real repository's evidence is too large to read whole.
    const focus = [...highlight.nodes].sort().join(",");
    if (focus !== focused.current || (grew && focus !== "")) {
      focused.current = focus;
      // Fit to the lit paths (edges and their ends); a step with no edges, such as list_alerts, fits its nodes.
      const paths = instance.edges(".on");
      const lit = paths.nonempty() ? paths.union(paths.connectedNodes()) : instance.nodes(".on");
      instance.stop();
      instance.animate(
        { fit: { eles: lit.nonempty() ? lit : instance.elements(), padding: 50 } },
        { duration: 350 },
      );
    }
  });

  return (
    <div className="canvas">
      <div ref={box} className="cy" />
      {graph.nodes.length === 0 ? (
        <span className="waiting">The graph appears as the agent touches it.</span>
      ) : null}
      {graph.dropped > 0 ? <span className="dropped">{graph.dropped} more nodes not drawn</span> : null}
    </div>
  );
}
