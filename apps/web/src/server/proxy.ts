import type { ErrorBody } from "@noderunner/core";

export const BODY_BYTES = 16_384;

export type Upstream = { readonly url: string; readonly token: string };

const error = (status: number, code: ErrorBody["error"]["code"], message: string) =>
  Response.json({ error: { code, message } } satisfies ErrorBody, { status });

/**
 * Forwards one allowed request to the worker: drops the caller's credentials, adds the worker token, sets
 * X-Forwarded-For to the visitor's address, and streams the answer back unbuffered.
 */
export async function forward(
  request: Request,
  path: string,
  upstream: Upstream,
  send: typeof fetch = fetch,
): Promise<Response> {
  const headers = new Headers({ Authorization: `Bearer ${upstream.token}` });
  const visitor = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  if (visitor) headers.set("X-Forwarded-For", visitor);
  const resume = request.headers.get("last-event-id");
  if (resume) headers.set("Last-Event-ID", resume);

  let body: string | undefined;
  if (request.method === "POST") {
    body = await request.text();
    if (new TextEncoder().encode(body).byteLength > BODY_BYTES)
      return error(400, "invalid", "Request body too large");
    headers.set("Content-Type", "application/json");
  }

  const search = new URL(request.url).search;
  try {
    const answer = await send(`${upstream.url}${path}${search}`, {
      method: request.method,
      headers,
      ...(body === undefined ? {} : { body }),
      signal: request.signal,
    });
    const type = answer.headers.get("content-type") ?? "application/json";
    return new Response(answer.body, {
      status: answer.status,
      headers: { "Content-Type": type, "Cache-Control": "no-store" },
    });
  } catch {
    return error(502, "upstream", "The worker is unreachable");
  }
}
