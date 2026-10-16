import { type ErrorCode, Fault } from "@noderunner/core";

export type IngestCode =
  | "ingest.missing"
  | "ingest.manifest"
  | "ingest.lockfile"
  | "ingest.upstream"
  | "ingest.aborted";

const surfaces: Readonly<Record<IngestCode, ErrorCode>> = {
  "ingest.missing": "missing",
  "ingest.manifest": "unsupported",
  "ingest.lockfile": "unsupported",
  "ingest.upstream": "upstream",
  "ingest.aborted": "internal",
};

/** An ingestion failure; the message is safe to show and never carries file content or a token. */
export class IngestError extends Fault {
  readonly code: IngestCode;
  readonly surface: ErrorCode;

  constructor(code: IngestCode, message: string) {
    super(message);
    this.name = "IngestError";
    this.code = code;
    this.surface = surfaces[code];
  }
}
