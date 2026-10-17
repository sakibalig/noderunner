/** Precision and recall of a run's mustFix against the import-reachable labels; null where undefined. */
export function score(
  mustFix: readonly string[] | null,
  labelled: ReadonlySet<string>,
): { readonly precision: number | null; readonly recall: number | null; readonly hits: number } {
  const claimed = new Set(mustFix ?? []);
  const hits = [...claimed].filter((key) => labelled.has(key)).length;
  return {
    precision: claimed.size === 0 ? null : hits / claimed.size,
    recall: labelled.size === 0 ? null : hits / labelled.size,
    hits,
  };
}

/** The median, and the range, of the values that exist. */
export function spread(values: readonly (number | null)[]): {
  readonly median: number | null;
  readonly min: number | null;
  readonly max: number | null;
} {
  const known = values.filter((v): v is number => v !== null).sort((a, b) => a - b);
  if (known.length === 0) return { median: null, min: null, max: null };
  const mid = Math.floor(known.length / 2);
  const median =
    known.length % 2 === 1 ? (known[mid] ?? null) : ((known[mid - 1] ?? 0) + (known[mid] ?? 0)) / 2;
  return { median, min: known[0] ?? null, max: known.at(-1) ?? null };
}
