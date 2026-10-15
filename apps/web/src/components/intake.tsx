"use client";

import { ErrorBody, RepoAccepted } from "@noderunner/core";
import { type FormEvent, useState } from "react";
import { Progress } from "./progress.tsx";

type State =
  | { readonly kind: "idle" }
  | { readonly kind: "sending" }
  | { readonly kind: "ingesting"; readonly repoId: string; readonly jobId: string }
  | { readonly kind: "failed"; readonly message: string };

export function Intake() {
  const [url, setUrl] = useState("");
  const [state, setState] = useState<State>({ kind: "idle" });

  async function submit(event: FormEvent) {
    event.preventDefault();
    setState({ kind: "sending" });
    try {
      const res = await fetch("/api/repos", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: url.trim() }),
      });
      const body: unknown = await res.json();
      const accepted = RepoAccepted.safeParse(body);
      if (res.ok && accepted.success) {
        setState({ kind: "ingesting", ...accepted.data });
        return;
      }
      const failure = ErrorBody.safeParse(body);
      setState({
        kind: "failed",
        message: failure.success ? failure.data.error.message : "Something went wrong",
      });
    } catch {
      setState({ kind: "failed", message: "The worker is unreachable" });
    }
  }

  return (
    <section className="panel">
      <form className="intake" onSubmit={submit}>
        <input
          aria-label="GitHub repository URL"
          placeholder="https://github.com/owner/name"
          value={url}
          onChange={(event) => setUrl(event.target.value)}
        />
        <button type="submit" disabled={state.kind === "sending" || url.trim() === ""}>
          Ingest
        </button>
      </form>
      {state.kind === "failed" ? <p className="error">{state.message}</p> : null}
      {state.kind === "ingesting" ? <Progress jobId={state.jobId} repoId={state.repoId} /> : null}
    </section>
  );
}
