"use client";

import { ErrorBody, PlanDraft } from "@noderunner/core";
import { useEffect, useState } from "react";
import { Report } from "./report.tsx";

const none = () => null;

type Load =
  | { kind: "loading" }
  | { kind: "none" }
  | { kind: "ready"; draft: PlanDraft }
  | { kind: "failed"; message: string };

/** The run's plan as the pull request it would open, with the human approval step. */
export function Draft({ runId }: { readonly runId: string }) {
  const [load, setLoad] = useState<Load>({ kind: "loading" });
  const [by, setBy] = useState("");
  const [approving, setApproving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const res = await fetch(`/api/runs/${encodeURIComponent(runId)}/plan`);
        if (!alive) return;
        if (res.status === 404) return setLoad({ kind: "none" });
        const body: unknown = await res.json();
        const parsed = PlanDraft.safeParse(body);
        if (parsed.success) return setLoad({ kind: "ready", draft: parsed.data });
        const failure = ErrorBody.safeParse(body);
        setLoad({
          kind: "failed",
          message: failure.success ? failure.data.error.message : "The plan could not be read",
        });
      } catch {
        if (alive) setLoad({ kind: "failed", message: "The worker is unreachable" });
      }
    })();
    return () => {
      alive = false;
    };
  }, [runId]);

  if (load.kind === "loading" || load.kind === "none") return null;
  if (load.kind === "failed") return <p className="error">{load.message}</p>;
  const { draft } = load;

  async function approve() {
    setApproving(true);
    setError(null);
    try {
      const res = await fetch(`/api/plans/${encodeURIComponent(draft.planId)}/approve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ by: by.trim() }),
      });
      if (res.ok) setLoad({ kind: "ready", draft: { ...draft, approved: true } });
      else {
        const failure = ErrorBody.safeParse(await res.json());
        setError(failure.success ? failure.data.error.message : "Could not approve");
      }
    } catch {
      setError("The worker is unreachable");
    } finally {
      setApproving(false);
    }
  }

  return (
    <section className="panel draft">
      <h2>
        Pull request <span className="hint">· {draft.approved ? "approved" : "awaiting approval"}</span>
      </h2>
      <Report report={draft.body} numberOf={none} selected={null} onCite={() => {}} />
      {draft.approved ? (
        <p className="approved">Approved. The pull request opens once shipping is enabled.</p>
      ) : (
        <form
          className="approve"
          onSubmit={(event) => {
            event.preventDefault();
            void approve();
          }}
        >
          <input
            aria-label="Your GitHub handle"
            placeholder="your GitHub handle"
            value={by}
            onChange={(e) => setBy(e.target.value)}
          />
          <button type="submit" disabled={approving || by.trim() === ""}>
            {approving ? "Approving…" : "Approve plan"}
          </button>
          {error ? <span className="error">{error}</span> : null}
        </form>
      )}
    </section>
  );
}
