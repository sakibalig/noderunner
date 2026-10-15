import { connect } from "node:net";

const PROBE_MS = 1_000;

/** Whether a TCP connection to the FalkorDB URL opens within a second. */
export function reachable(url: string): () => Promise<boolean> {
  const { hostname, port } = new URL(url);
  return () =>
    new Promise((resolve) => {
      const socket = connect({ host: hostname, port: Number(port || 6379), timeout: PROBE_MS });
      const done = (ok: boolean) => {
        socket.destroy();
        resolve(ok);
      };
      socket.once("connect", () => done(true));
      socket.once("timeout", () => done(false));
      socket.once("error", () => done(false));
    });
}
