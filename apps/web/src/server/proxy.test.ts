import { describe, expect, it } from "vitest";
import { BODY_BYTES, forward } from "./proxy.ts";

const upstream = { url: "http://worker:8787", token: "t".repeat(32) };

function capture() {
  const seen: { url: string; init: RequestInit }[] = [];
  const send = (async (url: string, init: RequestInit) => {
    seen.push({ url, init });
    return new Response('{"ok":true}', { status: 202, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return { seen, send };
}

describe("forward", () => {
  it("swaps the caller's credentials for the worker token and sets the visitor address", async () => {
    const { seen, send } = capture();
    const request = new Request("http://web/api/repos?x=1", {
      method: "POST",
      headers: {
        Authorization: "Bearer stolen",
        Cookie: "session=1",
        "x-forwarded-for": "9.9.9.9, 10.0.0.1",
        "last-event-id": "4",
      },
      body: '{"url":"https://github.com/acme/api"}',
    });
    const res = await forward(request, "/repos", upstream, send);
    expect(res.status).toBe(202);
    const sent = seen[0];
    expect(sent?.url).toBe("http://worker:8787/repos?x=1");
    const headers = new Headers(sent?.init.headers);
    expect(headers.get("Authorization")).toBe(`Bearer ${upstream.token}`);
    expect(headers.get("Cookie")).toBeNull();
    expect(headers.get("X-Forwarded-For")).toBe("9.9.9.9");
    expect(headers.get("Last-Event-ID")).toBe("4");
    expect(sent?.init.body).toBe('{"url":"https://github.com/acme/api"}');
  });

  it("refuses a body over the limit without calling the worker", async () => {
    const { seen, send } = capture();
    const request = new Request("http://web/api/repos", { method: "POST", body: "x".repeat(BODY_BYTES + 1) });
    const res = await forward(request, "/repos", upstream, send);
    expect(res.status).toBe(400);
    expect(seen).toHaveLength(0);
  });

  it("answers upstream when the worker is unreachable", async () => {
    const send = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    const res = await forward(new Request("http://web/api/repos"), "/repos", upstream, send);
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: { code: "upstream", message: "The worker is unreachable" } });
  });

  it("passes the worker's status, type, and body through", async () => {
    const send = (async () =>
      new Response("event: x\n\n", {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      })) as unknown as typeof fetch;
    const res = await forward(new Request("http://web/api/jobs/1/events"), "/jobs/1/events", upstream, send);
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    expect(await res.text()).toBe("event: x\n\n");
  });
});
