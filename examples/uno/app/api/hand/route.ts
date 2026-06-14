export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import type { Address } from "@nexus/types";
import { revealHand } from "../../../lib/game-backend";
import { jsonResponse } from "../../../lib/json-response";

export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as { player?: Address };
  if (!body.player) return jsonResponse({ ok: false, error: "player required" }, 400);
  const res = await revealHand(body.player);
  return jsonResponse(res, res.ok ? 200 : 403);
}
