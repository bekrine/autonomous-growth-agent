import { type NextRequest } from "next/server";

/**
 * Proxies `/api/backend/*` to the Express API.
 *
 * This is a Route Handler rather than a `next.config` rewrite on purpose:
 * rewrite destinations are baked into routes-manifest.json at build time, so
 * a container image built without API_URL would permanently point at
 * localhost regardless of the runtime env. Reading `process.env.API_URL`
 * here happens per-request, so the same image works locally (localhost:4000)
 * and in Docker (http://api:4000).
 */
export const dynamic = "force-dynamic";

function apiBaseUrl(): string {
  return process.env.API_URL ?? "http://localhost:4000";
}

async function proxy(request: NextRequest, path: string[]): Promise<Response> {
  const search = request.nextUrl.search;
  const target = `${apiBaseUrl()}/api/${path.join("/")}${search}`;

  const hasBody = request.method !== "GET" && request.method !== "HEAD";
  const response = await fetch(target, {
    method: request.method,
    headers: { "Content-Type": request.headers.get("content-type") ?? "application/json" },
    body: hasBody ? await request.text() : undefined,
    // The API is an internal service; don't let Next cache its responses.
    cache: "no-store",
  });

  return new Response(response.body, {
    status: response.status,
    headers: { "Content-Type": response.headers.get("content-type") ?? "application/json" },
  });
}

type RouteContext = { params: Promise<{ path: string[] }> };

export async function GET(request: NextRequest, context: RouteContext) {
  return proxy(request, (await context.params).path);
}

export async function POST(request: NextRequest, context: RouteContext) {
  return proxy(request, (await context.params).path);
}

export async function PATCH(request: NextRequest, context: RouteContext) {
  return proxy(request, (await context.params).path);
}

export async function DELETE(request: NextRequest, context: RouteContext) {
  return proxy(request, (await context.params).path);
}
