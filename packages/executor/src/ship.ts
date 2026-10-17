import {
  type Clock,
  type Db,
  type Forge,
  type GraphName,
  type PlanId,
  type RepoRef,
  type RunId,
  type Sandbox,
  type Sha,
  Shipment,
  Verification,
  verifyName,
} from "@noderunner/core";
import { tools } from "@noderunner/graph/cypher";
import { draft } from "./draft.ts";
import { edit } from "./edit.ts";
import { ExecutorError } from "./errors.ts";

const MANIFEST = "package.json";
const LOCK = "package-lock.json";

/** Re-ingests the repository at `repo.sha` into `verify:<runId>` with both package files replaced. */
export type Reingest = (
  repo: RepoRef & { readonly sha: Sha },
  override: { readonly manifest: string; readonly lock: string },
  runId: RunId,
  signal: AbortSignal,
) => Promise<void>;

export type Deps = {
  readonly db: Db;
  readonly forge: Pick<Forge, "read" | "propose">;
  readonly sandbox: Sandbox;
  readonly clock: Clock;
  readonly reingest: Reingest;
  /** PR_TARGET_OWNER: the only owner a pull request is ever opened against. */
  readonly target: string;
};

export type Request = { readonly graph: GraphName; readonly runId: RunId; readonly planId: PlanId };
export type Progress = { readonly step: "sandbox" | "verify"; readonly ms: number };
export type Opts = { readonly signal: AbortSignal; readonly onProgress: (progress: Progress) => void };
export type Ship = (req: Request, opts: Opts) => Promise<Shipment>;

/** The ship use case with its per-plan lock: refuse, fetch, edit, regenerate, verify, propose, record. */
export function shipper(deps: Deps): Ship {
  const shipping = new Set<string>();
  return async (req, opts) => {
    const { signal } = opts;
    const g = deps.db.graph(req.graph);
    const [plan] = await g.query(tools.ship.load, { planId: req.planId }, signal);
    if (plan === undefined) throw new ExecutorError("executor.missing", "No such plan");
    if (plan.approved !== true)
      throw new ExecutorError("executor.unapproved", "The plan has not been approved");
    if (plan.shipped !== null)
      throw new ExecutorError("executor.shipped", "The plan already has a pull request");
    if (shipping.has(req.planId))
      throw new ExecutorError("executor.busy", "The plan is already being shipped");
    if (plan.sha === null)
      throw new ExecutorError("executor.missing", "The repository has not finished ingesting");
    if (plan.upgrades.length === 0) throw new ExecutorError("executor.missing", "The plan has no upgrades");
    shipping.add(req.planId);
    try {
      const repo = { owner: plan.owner, name: plan.name, sha: plan.sha as Sha };
      const [manifest, lock] = await Promise.all([
        deps.forge.read(repo, repo.sha, MANIFEST, signal),
        deps.forge.read(repo, repo.sha, LOCK, signal),
      ]);
      if (manifest === null || lock === null)
        throw new ExecutorError(
          "executor.missing",
          "The repository has no root package.json and package-lock.json",
        );
      const edited = edit(manifest, plan.upgrades);
      const workspaces = await Promise.all(
        members(lock).map(async (path) => {
          const text = await deps.forge.read(repo, repo.sha, `${path}/${MANIFEST}`, signal);
          if (text === null)
            throw new ExecutorError("executor.missing", `The workspace ${path} has no package.json`);
          return { path, manifest: text };
        }),
      );

      let started = deps.clock.now();
      const regenerated = (
        await deps.sandbox.regenerate({ manifest: edited.manifest, lock, workspaces }, edited.refresh, signal)
      ).lock;
      lockfile(regenerated);
      opts.onProgress({ step: "sandbox", ms: deps.clock.now() - started });

      started = deps.clock.now();
      const { verification, reachable } = await check(
        deps,
        { ...req, repo, targets: plan.targets },
        { manifest: edited.manifest, lock: regenerated },
        signal,
      );
      opts.onProgress({ step: "verify", ms: deps.clock.now() - started });
      if (reachable.length > 0)
        return Shipment.parse({ outcome: "refused", reason: "new reachable finding", verification });

      const described = await draft(g, `${repo.owner}/${repo.name}`, req.planId, signal, verification);
      if (described === null) throw new ExecutorError("executor.missing", "No such plan");
      const branch = `noderunner/plan-${req.planId.slice(-8).toLowerCase()}`;
      const fork = { owner: deps.target, name: repo.name };
      const opened = await deps.forge.propose(
        fork,
        {
          base: repo.sha,
          branch,
          message: described.title,
          title: described.title,
          body: described.body,
          files: [
            { path: MANIFEST, content: edited.manifest },
            { path: LOCK, content: regenerated },
          ],
        },
        signal,
      );
      await g.query(
        tools.ship.record,
        {
          planId: req.planId,
          url: opened.url,
          number: opened.number,
          branch,
          targeted: verification.targeted,
          closed: verification.closed,
          newFindings: verification.newFindings,
          now: deps.clock.now(),
        },
        signal,
      );
      return Shipment.parse({ outcome: "opened", url: opened.url, branch, verification });
    } finally {
      shipping.delete(req.planId);
    }
  };
}

const segment = /^[A-Za-z0-9@][A-Za-z0-9._@-]*$/;

/** The lockfile's workspace packages: entries outside node_modules, each a plain relative path. */
export function members(lock: string): readonly string[] {
  let packages: unknown;
  try {
    packages = (JSON.parse(lock) as { packages?: unknown }).packages;
  } catch {
    throw new ExecutorError("executor.missing", "package-lock.json is not valid JSON");
  }
  if (typeof packages !== "object" || packages === null) return [];
  return Object.keys(packages).filter((path) => {
    if (path === "" || path.startsWith("node_modules/") || path.includes("/node_modules/")) return false;
    if (!path.split("/").every((part) => segment.test(part)))
      throw new ExecutorError(
        "executor.missing",
        "package-lock.json lists a workspace outside the repository",
      );
    return true;
  });
}

function lockfile(text: string): void {
  let version: unknown;
  try {
    version = (JSON.parse(text) as { lockfileVersion?: unknown }).lockfileVersion;
  } catch {
    throw new ExecutorError("executor.sandbox", "npm did not write a valid lockfile");
  }
  if (version !== 2 && version !== 3)
    throw new ExecutorError("executor.sandbox", "npm wrote a lockfile that is not version 2 or 3");
}

/** Re-tiers the regenerated lockfile in its own graph and compares it with the repository graph by finding key. */
async function check(
  deps: Deps,
  req: Request & { readonly repo: RepoRef & { readonly sha: Sha }; readonly targets: readonly string[] },
  files: { readonly manifest: string; readonly lock: string },
  signal: AbortSignal,
): Promise<{ readonly verification: Verification; readonly reachable: readonly string[] }> {
  const g = deps.db.graph(req.graph);
  const v = deps.db.graph(verifyName(req.runId));
  try {
    await deps.reingest(req.repo, files, req.runId, signal);
    const reached = new Set((await v.query(tools.tier.reachable, { keys: [] }, signal)).map((r) => r.key));
    const after = (await v.query(tools.ship.keys, {}, signal)).map((r) => r.key);
    const before = new Set((await g.query(tools.ship.keys, {}, signal)).map((r) => r.key));
    const present = new Set(after);
    const stillOpen = req.targets.filter((k) => present.has(k));
    const newFindings = after.filter((k) => !before.has(k));
    return {
      verification: Verification.parse({
        targeted: req.targets.length,
        closed: req.targets.length - stillOpen.length,
        stillOpen,
        newFindings,
      }),
      reachable: newFindings.filter((k) => reached.has(k)),
    };
  } finally {
    if ((await deps.db.list()).includes(v.name)) await v.drop().catch(() => undefined);
  }
}
