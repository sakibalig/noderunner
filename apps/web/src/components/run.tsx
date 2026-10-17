"use client";

import { RunEvent } from "@noderunner/core";
import { useCallback, useEffect, useMemo, useReducer } from "react";
import { initial, reducer } from "../state/reducer.ts";
import { Canvas } from "./canvas.tsx";
import { Draft } from "./draft.tsx";
import { Report } from "./report.tsx";
import { Timeline } from "./timeline.tsx";

const types = [
  "run.started",
  "step.started",
  "step.finished",
  "message.delta",
  "run.finished",
] as const satisfies readonly RunEvent["type"][];

/** The run view: follows the run's event stream and folds it through the pure reducer. */
export function Run({ runId, replay }: { readonly runId: string; readonly replay: boolean }) {
  const [state, dispatch] = useReducer(reducer, replay ? "replay" : "live", initial);

  useEffect(() => {
    const source = new EventSource(
      `/api/runs/${encodeURIComponent(runId)}/events${replay ? "?replay=1" : ""}`,
    );
    const read = (raw: MessageEvent<string>) => {
      const parsed = RunEvent.safeParse(JSON.parse(raw.data));
      if (!parsed.success) return;
      dispatch(parsed.data);
      if (parsed.data.type === "run.finished") source.close();
    };
    for (const type of types) source.addEventListener(type, read);
    return () => source.close();
  }, [runId, replay]);

  const steps = useMemo(
    () => state.order.flatMap((id) => (state.steps[id] ? [state.steps[id]] : [])),
    [state],
  );
  const numberOf = useCallback((stepId: string) => state.steps[stepId]?.seq ?? null, [state.steps]);
  const selected = state.selected?.id ?? null;
  const select = useCallback(
    (stepId: string) => dispatch(selected === stepId ? { type: "clear" } : { type: "select", stepId }),
    [selected],
  );

  const phase = state.phase;
  const status =
    phase.kind === "running"
      ? state.mode === "replay"
        ? "Replaying"
        : "Running"
      : phase.status === "done"
        ? phase.unverified
          ? "Done, citations unverified"
          : "Done"
        : phase.status === "capped"
          ? "Stopped at the step limit"
          : "Failed";

  return (
    <div className="run">
      <p className="sub">
        <span className={`status ${phase.kind === "running" ? "running" : phase.status}`}>{status}</span>
        {state.model ? <span className="mono"> · {state.model}</span> : null}
        <span> · {steps.length} tool calls</span>
        {state.graph.nodes.length > 0 ? <span> · {state.graph.nodes.length} graph nodes touched</span> : null}
      </p>
      <section className="panel graph">
        <h2>
          Evidence graph
          {selected ? (
            <span className="hint"> · step {state.steps[selected]?.seq} highlighted</span>
          ) : (
            <span className="hint"> · click a step or a citation</span>
          )}
        </h2>
        <Canvas graph={state.graph} highlight={state.highlight} />
      </section>
      <div className="panes">
        <section className="panel">
          <h2>Steps</h2>
          <Timeline steps={steps} selected={selected} onSelect={select} />
        </section>
        <section className="panel">
          <h2>Report</h2>
          <Report report={state.report} numberOf={numberOf} selected={selected} onCite={select} />
        </section>
      </div>
      {phase.kind === "finished" && phase.status !== "failed" ? <Draft runId={runId} /> : null}
    </div>
  );
}
