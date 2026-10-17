"use client";

import type { StepView } from "../state/reducer.ts";

type Props = {
  readonly steps: readonly StepView[];
  readonly selected: string | null;
  readonly onSelect: (stepId: string) => void;
};

export function Timeline({ steps, selected, onSelect }: Props) {
  if (steps.length === 0) return <p className="sub">Waiting for the first tool call…</p>;
  return (
    <ol className="timeline">
      {steps.map((step) => {
        const done = step.outcome.kind === "finished" ? step.outcome : null;
        const state = done === null ? "running" : done.ok ? "ok" : "failed";
        return (
          <li key={step.stepId} className={`${state}${selected === step.stepId ? " on" : ""}`}>
            <button type="button" onClick={() => onSelect(step.stepId)}>
              <span className="seq">{step.seq}</span>
              <span className="tool mono">{step.tool}</span>
              {done !== null ? <span className="ms">{done.ms} ms</span> : <span className="ms">running</span>}
              {done !== null ? <span className="summary">{done.summary}</span> : null}
            </button>
            {selected === step.stepId && done !== null && done.evidence.cypher.length > 0 ? (
              <details className="query">
                <summary>Show query</summary>
                {done.evidence.cypher.map((text) => (
                  <pre key={text}>{text}</pre>
                ))}
              </details>
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}
