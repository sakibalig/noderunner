import type { Funnel as FunnelData } from "@noderunner/core";
import { widths } from "../state/funnel.ts";

type Row = { readonly label: string; readonly value: number; readonly color: string; readonly href: string };

export function Funnel({ funnel, base }: { readonly funnel: FunnelData; readonly base: string }) {
  const share = widths(funnel);
  const rows: readonly Row[] = [
    { label: "All alerts", value: funnel.total, color: "#c9c4b6", href: base },
    { label: "In the production tree", value: funnel.production, color: "#c48a1c", href: base },
    {
      label: "Reachable from your code",
      value: funnel.reachable,
      color: "#b4451f",
      href: `${base}?tier=import-reachable`,
    },
    {
      label: "Still open after the plan",
      value: funnel.open,
      color: "#8f1d1d",
      href: `${base}?tier=import-reachable`,
    },
  ];
  return (
    <div className="funnel">
      {rows.map((row, index) => (
        <a key={row.label} className="row" href={row.href}>
          <span className="label">{row.label}</span>
          <span className="track">
            <span
              className="bar"
              style={{ width: `${share[index] ?? 0}%`, background: row.color, display: "block" }}
            />
          </span>
          <span className="count">{row.value}</span>
        </a>
      ))}
    </div>
  );
}
