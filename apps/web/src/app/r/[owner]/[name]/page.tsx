import { Tier } from "@noderunner/core";
import { notFound } from "next/navigation";
import { Alerts } from "../../../../components/alerts.tsx";
import { Funnel } from "../../../../components/funnel.tsx";
import { worker } from "../../../../server/worker.ts";

export const dynamic = "force-dynamic";

type Props = {
  readonly params: Promise<{ owner: string; name: string }>;
  readonly searchParams: Promise<{ tier?: string }>;
};

export default async function Repository({ params, searchParams }: Props) {
  const { owner, name } = await params;
  const parsed = Tier.safeParse((await searchParams).tier);
  const tier = parsed.success ? parsed.data : undefined;
  const summary = await worker.summary(owner, name);
  if (summary === null) notFound();
  const findings = await worker.findings(owner, name, tier === undefined ? {} : { tier });
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
      <section className="panel">
        <Funnel funnel={summary.funnel} base={base} />
      </section>
      <h2>Alerts</h2>
      <Alerts findings={findings} tier={tier} base={base} />
    </main>
  );
}
