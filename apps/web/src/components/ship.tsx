"use client";

import { ErrorBody, RunEvent, ShipAccepted, type Verification } from "@noderunner/core";
import { useEffect, useState } from "react";

type State =
  | { readonly kind: "idle" }
  | { readonly kind: "starting" }
  | { readonly kind: "running"; readonly jobId: string }
  | { readonly kind: "opened"; readonly url: string; readonly verification: Verification | null }
  | { readonly kind: "refused"; readonly reason: string; readonly verification: Verification | null }
  | { readonly kind: "failed"; readonly message: string };

const ends = ["pr.opened", "pr.refused", "job.failed"] as const;

function Checked({ v }: { readonly v: Verification | null }) {
  if (v === null) return null;
  return (
    <p className="sub">
      Verified by re-ingesting the new lockfile: {v.closed} of {v.targeted} targeted alerts closed
      {v.stillOpen.length > 0 ? `, ${v.stillOpen.length} still open` : ""}
      {v.newFindings.length > 0 ? `, ${v.newFindings.length} new` : ", no new alerts"}.
    </p>
  );
}

/** Ships an approved plan: regenerate, verify, and open the pull request, following the shipment job's stream. */
export function Ship({ planId, shipped }: { readonly planId: string; readonly shipped: string | null }) {
  const [state, setState] = useState<State>(
    shipped === null ? { kind: "idle" } : { kind: "opened", url: shipped, verification: null },
  );
  const jobId = state.kind === "running" ? state.jobId : null;

  useEffect(() => {
    if (jobId === null) return;
    const source = new EventSource(`/api/jobs/${encodeURIComponent(jobId)}/events`);
    const read = (raw: MessageEvent<string>) => {
      const parsed = RunEvent.safeParse(JSON.parse(raw.data));
      if (!parsed.success) return;
      const event = parsed.data;
      if (event.type === "pr.opened")
        setState({ kind: "opened", url: event.url, verification: event.verification });
      else if (event.type === "pr.refused")
        setState({ kind: "refused", reason: event.reason, verification: event.verification });
      else if (event.type === "job.failed") setState({ kind: "failed", message: event.message });
      else return;
      source.close();
    };
    for (const type of ends) source.addEventListener(type, read);
    return () => source.close();
  }, [jobId]);

  async function start() {
    setState({ kind: "starting" });
    try {
      const res = await fetch(`/api/plans/${encodeURIComponent(planId)}/ship`, { method: "POST" });
      const body: unknown = await res.json();
      const accepted = ShipAccepted.safeParse(body);
      if (accepted.success) return setState({ kind: "running", jobId: accepted.data.jobId });
      const failure = ErrorBody.safeParse(body);
      setState({ kind: "failed", message: failure.success ? failure.data.error.message : "Could not ship" });
    } catch {
      setState({ kind: "failed", message: "The worker is unreachable" });
    }
  }

  if (state.kind === "opened")
    return (
      <div className="ship">
        <p className="approved">
          Pull request opened: <a href={state.url}>{state.url}</a>
        </p>
        <Checked v={state.verification} />
      </div>
    );
  if (state.kind === "refused")
    return (
      <div className="ship">
        <p className="error">Not opened: {state.reason}.</p>
        <Checked v={state.verification} />
      </div>
    );
  return (
    <div className="ship">
      <p className="approved">Approved.</p>
      <button
        type="button"
        disabled={state.kind === "starting" || state.kind === "running"}
        onClick={() => void start()}
      >
        {state.kind === "idle" || state.kind === "failed"
          ? "Open pull request"
          : "Regenerating the lockfile and verifying…"}
      </button>
      {state.kind === "failed" ? <p className="error">{state.message}</p> : null}
    </div>
  );
}
