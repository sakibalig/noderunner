import { z } from "zod";
import { EnvError } from "./errors.ts";
import { GraphName } from "./ids.ts";
import { keyNames, Provider } from "./llm.ts";

const blank = (value: unknown) => (value === "" ? undefined : value);
const text = () => z.preprocess(blank, z.string().min(1));
const port = () => z.preprocess(blank, z.coerce.number().int().min(1).max(65_535));

const fields = {
  FALKORDB_URL: z
    .preprocess(blank, z.url({ protocol: /^rediss?$/ }))
    .describe("FalkorDB connection URL; secret"),
  LLM_PROVIDER: z.preprocess(blank, Provider.default("openai")),
  LLM_MODEL: z
    .preprocess(blank, z.string().min(1).optional())
    .describe("Model id; the provider's default when unset"),
  OPENAI_API_KEY: z.preprocess(blank, z.string().min(1).optional()).describe("OpenAI key; secret"),
  ANTHROPIC_API_KEY: z.preprocess(blank, z.string().min(1).optional()).describe("Anthropic key; secret"),
  GEMINI_API_KEY: z.preprocess(blank, z.string().min(1).optional()).describe("Gemini key; secret"),
  GITHUB_TOKEN: text().describe("Fine-grained GitHub token limited to the demo forks; secret"),
  PR_TARGET_OWNER: z
    .preprocess(blank, z.string().regex(/^[A-Za-z0-9-]+$/))
    .describe("Owner of the demo forks"),
  WORKER_URL: z.preprocess(blank, z.url()).describe("The worker's base URL, as the web app reaches it"),
  WORKER_TOKEN: z
    .preprocess(blank, z.string().min(32))
    .describe("Bearer token between web and worker; secret"),
  PORT: port().default(8787).describe("The worker's listening port"),
  WEB_ORIGIN: z.preprocess(blank, z.url()).describe("The only CORS origin the worker allows"),
  MCP_GRAPH: z
    .preprocess(
      blank,
      GraphName.refine((name) => name.startsWith("repo:"), "must be a repo: graph"),
    )
    .describe("The repository graph the MCP server is bound to"),
  MCP_ALLOW_WRITES: z
    .preprocess(blank, z.enum(["true", "false"]).default("false"))
    .transform((flag) => flag === "true")
    .describe("Whether MCP clients see act tools"),
  MCP_HTTP_PORT: port().optional().describe("Serve MCP over Streamable HTTP on this port instead of stdio"),
  MCP_TOKEN: z
    .preprocess(blank, z.string().min(32).optional())
    .describe("Bearer token for MCP over HTTP; secret"),
  SANDBOX_IMAGE: z
    .preprocess(blank, z.string().min(1).default("noderunner-sandbox:1"))
    .describe("Sandbox image"),
  CACHE_DIR: z
    .preprocess(blank, z.string().min(1).default(".cache"))
    .describe("Holds registry/ and other caches"),
  LOG_LEVEL: z
    .preprocess(blank, z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"))
    .describe("pino log level"),
};

function requireKey(
  env: { readonly LLM_PROVIDER: Provider } & Readonly<Record<string, unknown>>,
  ctx: z.RefinementCtx,
) {
  const name = keyNames[env.LLM_PROVIDER];
  if (env[name] === undefined)
    ctx.addIssue({
      code: "custom",
      path: [name],
      message: `required when LLM_PROVIDER is ${env.LLM_PROVIDER}`,
    });
}

const surfaces = {
  worker: z
    .object({
      FALKORDB_URL: fields.FALKORDB_URL,
      LLM_PROVIDER: fields.LLM_PROVIDER,
      LLM_MODEL: fields.LLM_MODEL,
      OPENAI_API_KEY: fields.OPENAI_API_KEY,
      ANTHROPIC_API_KEY: fields.ANTHROPIC_API_KEY,
      GEMINI_API_KEY: fields.GEMINI_API_KEY,
      GITHUB_TOKEN: fields.GITHUB_TOKEN,
      PR_TARGET_OWNER: fields.PR_TARGET_OWNER,
      WORKER_TOKEN: fields.WORKER_TOKEN,
      PORT: fields.PORT,
      WEB_ORIGIN: fields.WEB_ORIGIN,
      SANDBOX_IMAGE: fields.SANDBOX_IMAGE,
      CACHE_DIR: fields.CACHE_DIR,
      LOG_LEVEL: fields.LOG_LEVEL,
    })
    .superRefine(requireKey),
  mcp: z
    .object({
      FALKORDB_URL: fields.FALKORDB_URL,
      MCP_GRAPH: fields.MCP_GRAPH,
      MCP_ALLOW_WRITES: fields.MCP_ALLOW_WRITES,
      MCP_HTTP_PORT: fields.MCP_HTTP_PORT,
      MCP_TOKEN: fields.MCP_TOKEN,
      LOG_LEVEL: fields.LOG_LEVEL,
    })
    .refine((env) => env.MCP_HTTP_PORT === undefined || env.MCP_TOKEN !== undefined, {
      path: ["MCP_TOKEN"],
      message: "required when MCP_HTTP_PORT is set",
    }),
  web: z.object({ WORKER_URL: fields.WORKER_URL, WORKER_TOKEN: fields.WORKER_TOKEN }),
  eval: z
    .object({
      FALKORDB_URL: fields.FALKORDB_URL,
      LLM_PROVIDER: fields.LLM_PROVIDER,
      LLM_MODEL: fields.LLM_MODEL,
      OPENAI_API_KEY: fields.OPENAI_API_KEY,
      ANTHROPIC_API_KEY: fields.ANTHROPIC_API_KEY,
      GEMINI_API_KEY: fields.GEMINI_API_KEY,
      CACHE_DIR: fields.CACHE_DIR,
    })
    .superRefine(requireKey),
};

export type Surface = keyof typeof surfaces;

export type Env<S extends Surface> = z.infer<(typeof surfaces)[S]>;

/** Call once, in a composition root; empty strings count as unset. */
export function parseEnv<S extends Surface>(
  surface: S,
  source: Readonly<Record<string, string | undefined>>,
): Env<S> {
  const parsed = surfaces[surface].safeParse(source);
  if (parsed.success) return parsed.data as Env<S>;
  const names = [
    ...new Set(parsed.error.issues.map((issue) => String(issue.path[0] ?? "environment"))),
  ].sort();
  throw new EnvError(names);
}
