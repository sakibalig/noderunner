import { RunId } from "@noderunner/core";
import { notFound } from "next/navigation";
import { Run } from "../../../../../../components/run.tsx";

type Props = {
  readonly params: Promise<{ owner: string; name: string; id: string }>;
  readonly searchParams: Promise<{ replay?: string }>;
};

export default async function RunPage({ params, searchParams }: Props) {
  const { owner, name, id } = await params;
  const runId = RunId.safeParse(id);
  if (!runId.success) notFound();
  const replay = (await searchParams).replay === "1";
  return (
    <main className="wide">
      <p className="crumb">
        <a href={`/r/${owner}/${name}`} className="mono">
          {owner}/{name}
        </a>{" "}
        · run <span className="mono">{runId.data}</span> ·{" "}
        <a href={`/r/${owner}/${name}/runs/${runId.data}?replay=1`}>replay</a>
      </p>
      <Run runId={runId.data} replay={replay} />
    </main>
  );
}
