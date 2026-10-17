import type { Decision, FindingDetail } from "@noderunner/core";
import { Waive } from "./waive.tsx";

const tiers = {
  "import-reachable": "Loaded by production code",
  installed: "In the production tree, not loaded by production code",
  "dev-only": "In development dependencies only",
} as const;

const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);

function History({ decisions }: { readonly decisions: readonly Decision[] }) {
  if (decisions.length === 0) return <p className="sub">No decisions yet.</p>;
  return (
    <ol className="history">
      {decisions.map((d) => (
        <li key={d.id} className={d.staleReason ? "stale" : ""}>
          <strong>{d.kind}</strong> by <span className="mono">{d.by}</span> on {day(d.createdAt)}
          {d.expiresAt === null ? "" : `, until ${day(d.expiresAt)}`}
          {d.staleReason ? <span className="pill high">stale: {d.staleReason}</span> : null}
          <p>{d.reason}</p>
        </li>
      ))}
    </ol>
  );
}

/** One finding: the advisory, its tier, the shortest production path, decisions, and the waive form. */
export function Drawer({
  detail,
  repoId,
  close,
}: {
  readonly detail: FindingDetail;
  readonly repoId: string;
  readonly close: string;
}) {
  const { finding, vuln, path } = detail;
  const chain = path?.nodes.filter((n) => n.label !== "Vuln") ?? [];
  return (
    <aside className="drawer" aria-label={`Finding ${finding.key}`}>
      <a className="close" href={close} aria-label="Close">
        ×
      </a>
      <h2 className="mono heading">{vuln.id}</h2>
      <p>
        <span className={`pill ${vuln.severity}`}>{vuln.severity}</span>{" "}
        <span className="mono">{finding.package}</span> · {finding.status}
        {vuln.aliases.length > 0 ? <span className="sub"> · {vuln.aliases.join(", ")}</span> : null}
      </p>
      <p className="summary">{vuln.summary || "No advisory summary."}</p>
      <h3>Tier</h3>
      <p>
        <span className={`tier ${finding.tier ?? ""}`}>{finding.tier ?? "not tiered yet"}</span>{" "}
        {finding.tier ? tiers[finding.tier] : null}
      </p>
      <h3>Path from production code</h3>
      {chain.length === 0 ? (
        <p className="sub">No production file reaches this install.</p>
      ) : (
        <ol className="chain mono">
          {chain.map((n) => (
            <li key={n.key}>{n.name}</li>
          ))}
        </ol>
      )}
      <p className="sub mono">{finding.installs.join(", ")}</p>
      <h3>Decisions</h3>
      <History decisions={detail.decisions} />
      <Waive repoId={repoId} findingKey={finding.key} waived={finding.status === "waived"} />
    </aside>
  );
}
