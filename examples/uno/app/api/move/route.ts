export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import type { SignedDelegation } from "@nexus/core";
import type { Address } from "@nexus/types";
import type { UnoCard } from "../../../lib/uno-rules";
import { move } from "../../../lib/game-backend";
import { jsonResponse } from "../../../lib/json-response";

export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as {
    player?: Address;
    signedGameplay?: SignedDelegation;
    kind?: "play" | "draw";
    card?: UnoCard;
    chosenColor?: number;
  };
  if (!body.player || !body.signedGameplay || !body.kind) {
    return jsonResponse({ ok: false, error: "player + signedGameplay + kind required" }, 400);
  }
  const res = await move(body.player, body.signedGameplay, body.kind, body.card, body.chosenColor);
  if (res.ok) return jsonResponse(res, 200);
  // Map rule rejections (illegal/turn/already-won) to 409 like the old server.
  return jsonResponse(res, res.reject === "rule" ? 409 : 500);
}
