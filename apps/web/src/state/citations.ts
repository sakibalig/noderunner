/** A report split into text and `[s:<stepId>]` citations; a citation to an unknown step stays text. */
export type Part =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "cite"; readonly stepId: string; readonly n: number };

const pattern = /\[s:([0-9A-HJKMNP-TV-Z]{26})\]/g;

export function parts(report: string, known: (stepId: string) => number | null): readonly Part[] {
  const out: Part[] = [];
  let at = 0;
  for (const match of report.matchAll(pattern)) {
    const stepId = match[1] ?? "";
    const n = known(stepId);
    if (n === null) continue;
    if (match.index > at) out.push({ kind: "text", text: report.slice(at, match.index) });
    out.push({ kind: "cite", stepId, n });
    at = match.index + match[0].length;
  }
  if (at < report.length) out.push({ kind: "text", text: report.slice(at) });
  return out;
}

/** Drops the closing ```result block, which is for scoring, not for reading. */
export function readable(report: string): string {
  return report.replace(/```result[\s\S]*?```\s*$/, "").trimEnd();
}
