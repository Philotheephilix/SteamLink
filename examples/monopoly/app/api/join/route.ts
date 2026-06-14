export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import type { SignedDelegation } from "@nexus/core";
import type { Address } from "@nexus/types";
import { join } from "../../../lib/game-backend";
import { jsonResponse } from "../../../lib/json-response";

export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as {
    player?: Address;
    signedGameplay?: SignedDelegation;
    signedBudget?: SignedDelegation;
  };
  if (!body.player || !body.signedGameplay || !body.signedBudget) {
    return jsonResponse({ ok: false, error: "player + signedGameplay + signedBudget required" }, 400);
  }
  const res = await join(body.player, body.signedGameplay, body.signedBudget);
  return jsonResponse(res, res.ok ? 200 : 500);
}
