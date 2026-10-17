import type { Finding, Tier } from "@noderunner/core";

const filters: readonly { readonly label: string; readonly tier: Tier | undefined }[] = [
  { label: "All", tier: undefined },
  { label: "Import-reachable", tier: "import-reachable" },
  { label: "Installed", tier: "installed" },
  { label: "Dev-only", tier: "dev-only" },
];

/** The repository page with a tier filter and, optionally, a finding's drawer open. */
export function link(base: string, tier: Tier | undefined, finding?: string): string {
  const query = new URLSearchParams();
  if (tier !== undefined) query.set("tier", tier);
  if (finding !== undefined) query.set("finding", finding);
  const text = query.toString();
  return text === "" ? base : `${base}?${text}`;
}

export function Alerts({
  findings,
  tier,
  base,
  open,
}: {
  readonly findings: readonly Finding[];
  readonly tier: Tier | undefined;
  readonly base: string;
  readonly open: string | undefined;
}) {
  return (
    <>
      <nav className="filter">
        {filters.map((filter) => (
          <a key={filter.label} className={filter.tier === tier ? "on" : ""} href={link(base, filter.tier)}>
            {filter.label}
          </a>
        ))}
      </nav>
      {findings.length === 0 ? (
        <div className="panel empty">No alerts in this view.</div>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Package</th>
              <th>Advisory</th>
              <th>Severity</th>
              <th>Tier</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {findings.map((finding) => (
              <tr key={finding.key} className={finding.key === open ? "on" : ""}>
                <td className="mono">
                  <a href={link(base, tier, finding.key)}>{finding.package}</a>
                </td>
                <td className="mono">{finding.vulnId}</td>
                <td>
                  <span className={`pill ${finding.severity}`}>{finding.severity}</span>
                </td>
                <td>
                  <span className={`tier ${finding.tier ?? ""}`}>{finding.tier ?? "not tiered yet"}</span>
                </td>
                <td>{finding.status}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}
