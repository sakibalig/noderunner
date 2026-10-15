import { upstream } from "../../../server/config.ts";
import { forward } from "../../../server/proxy.ts";
import { forwardable } from "../../../server/routes.ts";

export const dynamic = "force-dynamic";

type Context = { readonly params: Promise<{ path: string[] }> };

async function handle(request: Request, context: Context): Promise<Response> {
  const path = `/${(await context.params).path.map(encodeURIComponent).join("/")}`;
  if (!forwardable(request.method, path))
    return Response.json({ error: { code: "missing", message: "No such route" } }, { status: 404 });
  return forward(request, path, upstream());
}

export const GET = handle;
export const POST = handle;
