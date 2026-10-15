import type { RepoList } from "@noderunner/core";

export function Cards({ repos }: { readonly repos: RepoList["repos"] }) {
  if (repos.length === 0) return <div className="panel empty">No repositories yet.</div>;
  return (
    <div className="cards">
      {repos.map((repo) => (
        <a key={repo.repoId} className="card panel" href={`/r/${repo.repoId}`}>
          <div className="name mono">{repo.repoId}</div>
          <div className="meta">
            {repo.counts.findings} alerts · {repo.counts.installs} installs · commit {repo.sha.slice(0, 7)}
          </div>
        </a>
      ))}
    </div>
  );
}
