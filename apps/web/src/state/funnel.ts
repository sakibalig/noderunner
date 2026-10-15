import type { Funnel } from "@noderunner/core";

/** Each bar's width as a percentage of all alerts; an empty repository draws empty bars. */
export function widths(funnel: Funnel): readonly number[] {
  const values = [funnel.total, funnel.production, funnel.reachable, funnel.open];
  return values.map((value) => (funnel.total === 0 ? 0 : Math.round((value / funnel.total) * 1000) / 10));
}
