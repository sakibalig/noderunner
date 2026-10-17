"use client";

import { ErrorBody } from "@noderunner/core";
import { useRouter } from "next/navigation";
import { useState } from "react";

const REASON = 500;

/** Records a waiver through the worker's record_decision tool, then reloads the drawer. */
export function Waive({
  repoId,
  findingKey,
  waived,
}: {
  readonly repoId: string;
  readonly findingKey: string;
  readonly waived: boolean;
}) {
  const router = useRouter();
  const [by, setBy] = useState("");
  const [reason, setReason] = useState("");
  const [days, setDays] = useState("90");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const handle = by.trim().replace(/^@/, "");

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/decisions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          repoId,
          key: findingKey,
          kind: "waive",
          reason: reason.trim(),
          by: handle,
          ...(days === "" ? {} : { expiresInDays: Number(days) }),
        }),
      });
      if (res.ok) {
        setReason("");
        router.refresh();
      } else {
        const failure = ErrorBody.safeParse(await res.json());
        setError(failure.success ? failure.data.error.message : "Could not record the waiver");
      }
    } catch {
      setError("The worker is unreachable");
    } finally {
      setSaving(false);
    }
  }

  return (
    <form
      className="waive"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <h3>{waived ? "Replace the waiver" : "Waive"}</h3>
      <textarea
        aria-label="Reason"
        placeholder="Why this alert does not matter here"
        maxLength={REASON}
        rows={3}
        value={reason}
        onChange={(e) => setReason(e.target.value)}
      />
      <div className="row">
        <input
          aria-label="Your GitHub handle"
          placeholder="your GitHub handle"
          value={by}
          onChange={(e) => setBy(e.target.value)}
        />
        <select aria-label="Expires" value={days} onChange={(e) => setDays(e.target.value)}>
          <option value="30">30 days</option>
          <option value="90">90 days</option>
          <option value="365">1 year</option>
          <option value="">No expiry</option>
        </select>
        <button type="submit" disabled={saving || handle === "" || reason.trim() === ""}>
          {saving ? "Saving…" : "Waive"}
        </button>
      </div>
      {error ? <p className="error">{error}</p> : null}
    </form>
  );
}
