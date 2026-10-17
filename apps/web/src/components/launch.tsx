"use client";

import { ErrorBody, RunAccepted } from "@noderunner/core";
import { useRouter } from "next/navigation";
import { useState } from "react";

/** Starts a triage run on this repository and opens its run view. */
export function Launch({ repoId }: { readonly repoId: string }) {
  const router = useRouter();
  const [state, setState] = useState<
    { kind: "idle" } | { kind: "starting" } | { kind: "failed"; message: string }
  >({
    kind: "idle",
  });

  async function start() {
    setState({ kind: "starting" });
    try {
      const res = await fetch("/api/runs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ repoId, agent: "triage" }),
      });
      const body: unknown = await res.json();
      const accepted = RunAccepted.safeParse(body);
      if (res.ok && accepted.success) {
        router.push(`/r/${repoId}/runs/${accepted.data.runId}`);
        return;
      }
      const failure = ErrorBody.safeParse(body);
      setState({
        kind: "failed",
        message: failure.success ? failure.data.error.message : "Could not start the run",
      });
    } catch {
      setState({ kind: "failed", message: "The worker is unreachable" });
    }
  }

  return (
    <div className="launch">
      <button type="button" onClick={start} disabled={state.kind === "starting"}>
        {state.kind === "starting" ? "Starting…" : "Run triage agent"}
      </button>
      {state.kind === "failed" ? <span className="error">{state.message}</span> : null}
    </div>
  );
}
