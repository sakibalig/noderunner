import type { Query } from "@noderunner/core";
import { z } from "zod";
import { query, write } from "./define.ts";

/** One index the graph contract requires, with the constant that creates it. */
export type Index = {
  readonly label: string;
  readonly property: string;
  readonly create: Query<Record<string, never>>;
};

// FalkorDB rejects a second CREATE INDEX on the same property, so migrate reads this list first.
export const indexes = query(
  "schema.indexes",
  `CALL db.indexes() YIELD label, properties, entitytype
WITH label, properties, entitytype WHERE entitytype = 'NODE'
RETURN label, properties ORDER BY label LIMIT 100`,
  z.object({
    label: z.string().describe("The indexed node label"),
    properties: z.array(z.string()).describe("The indexed properties of that label"),
  }),
);

export const repo: readonly Index[] = [
  { label: "Repo", property: "url", create: write("schema.repoUrl", "CREATE INDEX FOR (n:Repo) ON (n.url)") },
  {
    label: "File",
    property: "path",
    create: write("schema.filePath", "CREATE INDEX FOR (n:File) ON (n.path)"),
  },
  {
    label: "Package",
    property: "name",
    create: write("schema.packageName", "CREATE INDEX FOR (n:Package) ON (n.name)"),
  },
  {
    label: "Install",
    property: "lock_path",
    create: write("schema.installLockPath", "CREATE INDEX FOR (n:Install) ON (n.lock_path)"),
  },
  { label: "Vuln", property: "id", create: write("schema.vulnId", "CREATE INDEX FOR (n:Vuln) ON (n.id)") },
  {
    label: "Finding",
    property: "key",
    create: write("schema.findingKey", "CREATE INDEX FOR (n:Finding) ON (n.key)"),
  },
  {
    label: "Person",
    property: "handle",
    create: write("schema.personHandle", "CREATE INDEX FOR (n:Person) ON (n.handle)"),
  },
  { label: "Run", property: "id", create: write("schema.runId", "CREATE INDEX FOR (n:Run) ON (n.id)") },
  { label: "Step", property: "id", create: write("schema.stepId", "CREATE INDEX FOR (n:Step) ON (n.id)") },
];

export const advisories: readonly Index[] = [
  { label: "PV", property: "key", create: write("schema.pvKey", "CREATE INDEX FOR (n:PV) ON (n.key)") },
  { label: "Adv", property: "id", create: write("schema.advId", "CREATE INDEX FOR (n:Adv) ON (n.id)") },
];
