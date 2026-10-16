import { type ParserPlugin, parse } from "@babel/parser";

/** The module specifiers one file loads at run time, in order of first appearance. */
export type Found = { readonly sources: readonly string[]; readonly parsed: "ast" | "regex" };

type Node = { readonly type: string; readonly [key: string]: unknown };

const skip = new Set([
  "loc",
  "start",
  "end",
  "extra",
  "range",
  "comments",
  "leadingComments",
  "trailingComments",
]);
// Used only when Babel cannot parse a file: statement-level imports and exports, and literal require() or import().
const fallback = [
  /^\s*(?:import|export)(?!\s+type\b)[^'"`;]*?\bfrom\s*(["'])([^"'\n]+)\1/gm,
  /^\s*import\s*(["'])([^"'\n]+)\1/gm,
  /\b(?:require|import)\s*\(\s*(["'])([^"'\n]+)\1\s*\)/g,
];

function isNode(value: unknown): value is Node {
  return typeof value === "object" && value !== null && "type" in value && typeof value.type === "string";
}

function plugins(path: string): ParserPlugin[] {
  if (/\.(ts|mts|cts)$/.test(path)) return ["typescript", "decorators-legacy"];
  if (path.endsWith(".tsx")) return ["typescript", "jsx", "decorators-legacy"];
  return ["jsx", "decorators-legacy"];
}

/** The text of a string literal, or of a template literal with no expressions. */
function literal(value: unknown): string | null {
  if (!isNode(value)) return null;
  if (value.type === "StringLiteral" && typeof value.value === "string") return value.value;
  if (
    value.type === "TemplateLiteral" &&
    Array.isArray(value.expressions) &&
    value.expressions.length === 0
  ) {
    const [quasi] = Array.isArray(value.quasis) ? value.quasis : [];
    if (isNode(quasi) && typeof quasi.value === "object" && quasi.value !== null && "cooked" in quasi.value) {
      return typeof quasi.value.cooked === "string" ? quasi.value.cooked : null;
    }
  }
  return null;
}

function first(args: unknown): unknown {
  return Array.isArray(args) ? args[0] : undefined;
}

function isRequire(callee: unknown): boolean {
  return isNode(callee) && callee.type === "Identifier" && callee.name === "require";
}

/** The source a node loads at run time, or null; type-only imports and exports load nothing. */
function sourceOf(node: Node): string | null {
  switch (node.type) {
    case "ImportDeclaration": {
      if (node.importKind === "type" || node.importKind === "typeof") return null;
      const specifiers = Array.isArray(node.specifiers) ? node.specifiers : [];
      if (specifiers.length > 0 && specifiers.every((s) => isNode(s) && s.importKind === "type")) return null;
      return literal(node.source);
    }
    case "ExportNamedDeclaration":
    case "ExportAllDeclaration":
      return node.exportKind === "type" ? null : literal(node.source);
    case "ImportExpression":
      return literal(node.source);
    case "TSImportEqualsDeclaration": {
      const ref = node.moduleReference;
      if (node.importKind === "type" || !isNode(ref) || ref.type !== "TSExternalModuleReference") return null;
      return literal(ref.expression);
    }
    case "CallExpression": {
      const { callee } = node;
      if (isNode(callee) && callee.type === "Import") return literal(first(node.arguments));
      if (isRequire(callee)) return literal(first(node.arguments));
      if (
        isNode(callee) &&
        callee.type === "MemberExpression" &&
        isRequire(callee.object) &&
        isNode(callee.property) &&
        callee.property.type === "Identifier" &&
        callee.property.name === "resolve"
      ) {
        return literal(first(node.arguments));
      }
      return null;
    }
    default:
      return null;
  }
}

/** Collects every run-time module specifier in one source file, falling back to a regex when it cannot parse. */
export function imports(path: string, text: string): Found {
  const seen = new Set<string>();
  let program: unknown;
  try {
    program = parse(text, { sourceType: "unambiguous", errorRecovery: true, plugins: plugins(path) }).program;
  } catch {
    const hits = fallback
      .flatMap((pattern) => [...text.matchAll(pattern)])
      .sort((x, y) => (x.index ?? 0) - (y.index ?? 0));
    for (const hit of hits) if (hit[2] !== undefined) seen.add(hit[2]);
    return { sources: [...seen], parsed: "regex" };
  }
  const stack: unknown[] = [program];
  while (stack.length > 0) {
    const value = stack.pop();
    if (Array.isArray(value)) {
      for (let i = value.length - 1; i >= 0; i -= 1) stack.push(value[i]);
      continue;
    }
    if (!isNode(value)) continue;
    const source = sourceOf(value);
    if (source !== null) seen.add(source);
    const children = Object.entries(value).filter(([key]) => !skip.has(key));
    for (let i = children.length - 1; i >= 0; i -= 1) {
      const child = children[i]?.[1];
      if (typeof child === "object" && child !== null) stack.push(child);
    }
  }
  return { sources: [...seen], parsed: "ast" };
}
