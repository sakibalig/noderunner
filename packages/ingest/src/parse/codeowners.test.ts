import { describe, expect, it } from "vitest";
import { Codeowners } from "./codeowners.ts";

const file = `
# Default owners
*                 @acme/core
/src/             @Alice
/src/api/*.ts     @acme/web @bob   # API team
docs/             docs@acme.dev
/src/generated/
`;

describe("Codeowners", () => {
  const owners = new Codeowners(file);
  const handles = (path: string) => owners.ownersOf(path).map((owner) => owner.handle);

  it("lets the last matching rule win", () => {
    expect(handles("src/api/server.ts")).toEqual(["@acme/web", "@bob"]);
    expect(handles("src/lib/util.ts")).toEqual(["@alice"]);
    expect(handles("package.json")).toEqual(["@acme/core"]);
  });

  it("anchors a leading slash and matches a bare name anywhere", () => {
    expect(handles("lib/src/x.ts")).toEqual(["@acme/core"]);
    expect(handles("packages/docs/readme.md")).toEqual([]);
  });

  it("gives no owners when the last match names nobody", () => {
    expect(handles("src/generated/types.ts")).toEqual([]);
  });

  it("tells teams from users and lowercases handles", () => {
    expect(owners.ownersOf("src/api/server.ts")).toEqual([
      { handle: "@acme/web", kind: "team" },
      { handle: "@bob", kind: "user" },
    ]);
  });

  it("drops e-mail owners and reports them", () => {
    expect(owners.dropped).toEqual(["docs@acme.dev"]);
    expect(handles("docs/guide.md")).toEqual([]);
  });

  it("treats an empty file as no rules", () => {
    expect(new Codeowners("\n# only a comment\n").ownersOf("a.ts")).toEqual([]);
  });
});
