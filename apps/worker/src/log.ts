/** The structured logger the worker passes around; pino satisfies it. */
export type Log = {
  info(fields: Readonly<Record<string, unknown>>, event: string): void;
  warn(fields: Readonly<Record<string, unknown>>, event: string): void;
  error(fields: Readonly<Record<string, unknown>>, event: string): void;
};
