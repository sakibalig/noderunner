/** The only source of time below a composition root. */
export interface Clock {
  now(): number;
}
