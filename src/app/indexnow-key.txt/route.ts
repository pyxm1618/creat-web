import { env } from "@/platform/config/env";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  if (!env.indexNowKey) {
    return new Response("Not Found", {
      status: 404,
      headers: {
        "cache-control": "no-store",
        "content-type": "text/plain; charset=utf-8",
        "x-robots-tag": "noindex, nofollow",
      },
    });
  }

  return new Response(env.indexNowKey, {
    status: 200,
    headers: {
      "cache-control": "no-store",
      "content-type": "text/plain; charset=utf-8",
      "x-content-type-options": "nosniff",
      "x-robots-tag": "noindex, nofollow",
    },
  });
}
