import { describe, expect, it } from "vitest";
import { blocks } from "./markdown.ts";

describe("blocks", () => {
  it("reads headings, tables without their divider, lists, and paragraphs", () => {
    const md = "## Funnel\n| Stage | Alerts |\n|---|---|\n| All | 3 |\n\nSome text\nwrapped.\n\n- one\n- two";
    expect(blocks(md)).toEqual([
      { kind: "heading", level: 2, text: "Funnel" },
      { kind: "table", head: ["Stage", "Alerts"], rows: [["All", "3"]] },
      { kind: "paragraph", text: "Some text wrapped." },
      { kind: "list", items: ["one", "two"] },
    ]);
  });
});
