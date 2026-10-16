import { IngestError } from "../errors.ts";

/** Waits `ms`, or rejects with `ingest.aborted` as soon as `signal` fires. */
export function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new IngestError("ingest.aborted", "ingestion was stopped"));
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", stop);
      resolve();
    }, ms);
    const stop = () => {
      clearTimeout(timer);
      reject(new IngestError("ingest.aborted", "ingestion was stopped"));
    };
    signal.addEventListener("abort", stop, { once: true });
  });
}
