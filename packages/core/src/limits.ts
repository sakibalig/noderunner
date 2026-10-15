export const limits = Object.freeze({
  evidenceNodes: 300,
  evidenceEdges: 600,
  modelChars: 6_000,
  runCalls: 15,
  mcpCalls: 100,
  toolMs: 20_000,
  shipMs: 240_000,
  cypherMs: 5_000,
  cypherRows: 200,
  alertRows: 40,
  ringEvents: 500,
  subgraphNodes: 400,
  batchRows: 500,
  maxTokens: 16_000,
});
export type Limits = typeof limits;
