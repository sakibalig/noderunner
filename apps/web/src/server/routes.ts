/** The method and path pairs of contracts/api/worker.md the proxy forwards; anything else answers `missing`. */
const allowed: readonly (readonly [string, RegExp])[] = [
  ["POST", /^\/repos$/],
  ["GET", /^\/repos$/],
  ["GET", /^\/repos\/[^/]+\/[^/]+\/summary$/],
  ["GET", /^\/repos\/[^/]+\/[^/]+\/findings$/],
  ["GET", /^\/repos\/[^/]+\/[^/]+\/findings\/[^/]+$/],
  ["GET", /^\/repos\/[^/]+\/[^/]+\/subgraph$/],
  ["POST", /^\/runs$/],
  ["GET", /^\/runs\/[^/]+$/],
  ["GET", /^\/runs\/[^/]+\/events$/],
  ["POST", /^\/plans\/[^/]+\/approve$/],
  ["POST", /^\/plans\/[^/]+\/ship$/],
  ["POST", /^\/decisions$/],
  ["GET", /^\/jobs\/[^/]+\/events$/],
  ["GET", /^\/healthz$/],
];

export function forwardable(method: string, path: string): boolean {
  return allowed.some(([m, pattern]) => m === method && pattern.test(path));
}
