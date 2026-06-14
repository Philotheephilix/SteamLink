export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import type { Address } from "@nexus/types";
import { act } from "../../../lib/game-backend";
import { jsonResponse } from "../../../lib/json-response";

export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as { player?: Address; action?: string; spaceId?: number };
  if (!body.player || !body.action) {
    return jsonResponse({ ok: false, error: "player + action required" }, 400);
  }
  const res = await act(body.player, body.action, body.spaceId);
  if (res.ok) return jsonResponse(res, 200);
  // Map rule rejections (stale turn / nonce / already-won) to 409 like the old server.
  return jsonResponse(res, res.reject === "rule" ? 409 : 500);
}
