import "server-only";
import {
  type Finding,
  FindingDetail,
  FindingList,
  type FindingQuery,
  RepoList,
  type RepoSummary,
  RepoSummary as RepoSummarySchema,
} from "@noderunner/core";
import { upstream } from "./config.ts";

/** Server components read the worker directly with its token; the browser goes through /api. */
async function get(path: string): Promise<Response> {
  const { url, token } = upstream();
  return fetch(`${url}${path}`, { headers: { Authorization: `Bearer ${token}` }, cache: "no-store" });
}

async function ok(res: Response): Promise<unknown> {
  if (!res.ok) throw new Error(`The worker answered ${res.status}`);
  return res.json();
}

export const worker = {
  async repos(): Promise<RepoList["repos"]> {
    return RepoList.parse(await ok(await get("/repos"))).repos;
  },

  async summary(owner: string, name: string): Promise<RepoSummary | null> {
    const res = await get(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/summary`);
    return res.status === 404 ? null : RepoSummarySchema.parse(await ok(res));
  },

  async findings(owner: string, name: string, filter: FindingQuery): Promise<readonly Finding[]> {
    const query = new URLSearchParams(
      Object.entries(filter).filter(([, v]) => v !== undefined) as [string, string][],
    );
    const res = await get(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/findings?${query}`,
    );
    return FindingList.parse(await ok(res)).findings;
  },

  async finding(owner: string, name: string, key: string): Promise<FindingDetail | null> {
    const res = await get(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/findings/${encodeURIComponent(key)}`,
    );
    return res.status === 404 ? null : FindingDetail.parse(await ok(res));
  },
};
