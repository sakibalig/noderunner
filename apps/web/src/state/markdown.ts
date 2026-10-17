/** The small markdown subset agent reports use: headings, tables, bullet lists, and paragraphs. */
export type MdBlock =
  | { readonly kind: "heading"; readonly level: 2 | 3; readonly text: string }
  | {
      readonly kind: "table";
      readonly head: readonly string[];
      readonly rows: readonly (readonly string[])[];
    }
  | { readonly kind: "list"; readonly items: readonly string[] }
  | { readonly kind: "paragraph"; readonly text: string };

const cells = (line: string) =>
  line
    .trim()
    .replace(/^\||\|$/g, "")
    .split("|")
    .map((cell) => cell.trim());

export function blocks(text: string): readonly MdBlock[] {
  const out: MdBlock[] = [];
  const lines = text.split("\n");
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? "";
    if (line.trim() === "") {
      i++;
      continue;
    }
    const heading = /^(#{2,3})\s+(.*)$/.exec(line);
    if (heading) {
      out.push({ kind: "heading", level: heading[1] === "##" ? 2 : 3, text: heading[2] ?? "" });
      i++;
      continue;
    }
    if (line.trim().startsWith("|")) {
      const rows: string[][] = [];
      while (i < lines.length && (lines[i] ?? "").trim().startsWith("|")) rows.push(cells(lines[i++] ?? ""));
      const body = rows.filter((row) => !row.every((cell) => /^:?-{2,}:?$/.test(cell)));
      out.push({ kind: "table", head: body[0] ?? [], rows: body.slice(1) });
      continue;
    }
    if (/^\s*[-*]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i] ?? ""))
        items.push((lines[i++] ?? "").replace(/^\s*[-*]\s+/, ""));
      out.push({ kind: "list", items });
      continue;
    }
    const para: string[] = [];
    while (
      i < lines.length &&
      (lines[i] ?? "").trim() !== "" &&
      !/^(#{2,3}\s|\||\s*[-*]\s)/.test(lines[i] ?? "")
    )
      para.push(lines[i++] ?? "");
    out.push({ kind: "paragraph", text: para.join(" ") });
  }
  return out;
}
