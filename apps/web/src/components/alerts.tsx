import type { Finding, Tier } from "@noderunner/core";

const filters: readonly { readonly label: string; readonly tier: Tier | undefined }[] = [
  { label: "All", tier: undefined },
  { label: "Import-reachable", tier: "import-reachable" },
  { label: "Installed", tier: "installed" },
  { label: "Dev-only", tier: "dev-only" },
];

export function Alerts({
  findings,
  tier,
  base,
}: {
  readonly findings: readonly Finding[];
  readonly tier: Tier | undefined;
  readonly base: string;
}) {
  return (
    <>
      <nav className="filter">
        {filters.map((filter) => (
          <a
            key={filter.label}
            className={filter.tier === tier ? "on" : ""}
            href={filter.tier === undefined ? base : `${base}?tier=${filter.tier}`}
          >
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
              <tr key={finding.key}>
                <td className="mono">{finding.package}</td>
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
