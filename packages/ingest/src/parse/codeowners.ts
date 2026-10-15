import ignore, { type Ignore } from "ignore";

export type Owner = { readonly handle: string; readonly kind: "user" | "team" };

type Rule = { readonly matcher: Ignore; readonly owners: readonly Owner[] };

/** A parsed CODEOWNERS file: the last rule matching a path names its owners, as GitHub applies it. */
export class Codeowners {
  readonly #rules: readonly Rule[];
  /** Owners that are not GitHub handles (e-mail addresses), which are dropped. */
  readonly dropped: readonly string[];

  constructor(text: string) {
    const rules: Rule[] = [];
    const dropped: string[] = [];
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.replace(/(^|\s)#.*$/, "").trim();
      if (line === "") continue;
      const [pattern, ...tokens] = line.split(/\s+/);
      if (pattern === undefined) continue;
      const owners: Owner[] = [];
      for (const token of tokens) {
        if (/^@[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/.test(token))
          owners.push({ handle: token.toLowerCase(), kind: "team" });
        else if (/^@[A-Za-z0-9-]+$/.test(token)) owners.push({ handle: token.toLowerCase(), kind: "user" });
        else dropped.push(token);
      }
      rules.push({ matcher: ignore().add(pattern), owners });
    }
    this.#rules = rules;
    this.dropped = dropped;
  }

  /** The owners of a repository-relative path; empty when no rule matches or the last match names nobody. */
  ownersOf(path: string): readonly Owner[] {
    for (let i = this.#rules.length - 1; i >= 0; i--) {
      const rule = this.#rules[i];
      if (rule?.matcher.ignores(path)) return rule.owners;
    }
    return [];
  }
}
