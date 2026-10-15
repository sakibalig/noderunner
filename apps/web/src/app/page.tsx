import { Cards } from "../components/cards.tsx";
import { Intake } from "../components/intake.tsx";
import { worker } from "../server/worker.ts";

export const dynamic = "force-dynamic";

export default async function Home() {
  const repos = await worker.repos();
  return (
    <main>
      <h1>Triage a repository</h1>
      <p className="sub">
        Paste a public npm repository. Noderunner loads it into a graph and works out which alerts production
        code can reach.
      </p>
      <Intake />
      <h2>Repositories</h2>
      <Cards repos={repos} />
    </main>
  );
}
