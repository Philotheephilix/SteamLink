export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import type { Address } from "@nexus/types";
import { ensureGame } from "../../../lib/game-backend";
import { jsonResponse } from "../../../lib/json-response";

export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as { human?: Address; bots?: Address[]; fee?: string };
  if (!body.human || !Array.isArray(body.bots)) {
    return jsonResponse({ ok: false, error: "human + bots required" }, 400);
  }
  // force a fresh seating when explicitly creating a new game.
  const res = await ensureGame(body.human, body.bots, body.fee, true);
  return jsonResponse(res, res.ok ? 200 : 500);
}
