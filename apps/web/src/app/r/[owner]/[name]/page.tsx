import { Tier } from "@noderunner/core";
import { notFound } from "next/navigation";
import { Alerts, link } from "../../../../components/alerts.tsx";
import { Drawer } from "../../../../components/drawer.tsx";
import { Funnel } from "../../../../components/funnel.tsx";
import { Launch } from "../../../../components/launch.tsx";
import { worker } from "../../../../server/worker.ts";

export const dynamic = "force-dynamic";

type Props = {
  readonly params: Promise<{ owner: string; name: string }>;
  readonly searchParams: Promise<{ tier?: string; finding?: string }>;
};

export default async function Repository({ params, searchParams }: Props) {
  const { owner, name } = await params;
  const query = await searchParams;
  const parsed = Tier.safeParse(query.tier);
  const tier = parsed.success ? parsed.data : undefined;
  const summary = await worker.summary(owner, name);
  if (summary === null) notFound();
  const [findings, detail] = await Promise.all([
    worker.findings(owner, name, tier === undefined ? {} : { tier }),
    query.finding === undefined ? null : worker.finding(owner, name, query.finding),
  ]);
  const base = `/r/${owner}/${name}`;
  return (
    <main>
      <h1 className="mono">
        {owner}/{name}
      </h1>
      <p className="sub">
        {summary.counts.files} files · {summary.counts.installs} installs · {summary.counts.vulns}{" "}
        vulnerabilities
      </p>
      <Launch repoId={`${owner}/${name}`} />
      {summary.lastRun ? (
        <p className="sub">
          Last run: <a href={`${base}/runs/${summary.lastRun.runId}`}>{summary.lastRun.status}</a>
        </p>
      ) : null}
      <section className="panel">
        <Funnel funnel={summary.funnel} base={base} />
      </section>
      <h2>Alerts</h2>
      <Alerts findings={findings} tier={tier} base={base} open={query.finding} />
      {detail ? <Drawer detail={detail} repoId={`${owner}/${name}`} close={link(base, tier)} /> : null}
    </main>
  );
}
