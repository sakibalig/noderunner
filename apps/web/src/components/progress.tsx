"use client";

import { RunEvent, type Stage } from "@noderunner/core";
import { useEffect, useState } from "react";

const stages: readonly Stage[] = ["fetch", "lockfile", "imports", "advisories", "people", "prune"];

type State =
  | { readonly kind: "running"; readonly done: ReadonlySet<Stage> }
  | { readonly kind: "finished" }
  | { readonly kind: "failed"; readonly message: string };

/** Follows one ingestion job's stream until it ends; closing it on the last event stops the browser reconnecting. */
export function Progress({ jobId, repoId }: { readonly jobId: string; readonly repoId: string }) {
  const [state, setState] = useState<State>({ kind: "running", done: new Set() });

  useEffect(() => {
    const source = new EventSource(`/api/jobs/${encodeURIComponent(jobId)}/events`);
    const read = (raw: MessageEvent<string>) => {
      const parsed = RunEvent.safeParse(JSON.parse(raw.data));
      if (!parsed.success) return;
      const event = parsed.data;
      if (event.type === "ingest.progress")
        setState((prev) =>
          prev.kind === "running" ? { kind: "running", done: new Set([...prev.done, event.stage]) } : prev,
        );
      if (event.type === "ingest.finished") {
        setState({ kind: "finished" });
        source.close();
      }
      if (event.type === "job.failed") {
        setState({ kind: "failed", message: event.message });
        source.close();
      }
    };
    for (const type of ["ingest.progress", "ingest.finished", "job.failed"])
      source.addEventListener(type, read);
    return () => source.close();
  }, [jobId]);

  if (state.kind === "failed") return <p className="error">{state.message}</p>;
  return (
    <>
      <ol className="stages">
        {stages.map((stage) => (
          <li key={stage} className={state.kind === "finished" || state.done.has(stage) ? "done" : ""}>
            {stage}
          </li>
        ))}
      </ol>
      {state.kind === "finished" ? (
        <p>
          Ingested. <a href={`/r/${repoId}`}>Open {repoId}</a>
        </p>
      ) : null}
    </>
  );
}
