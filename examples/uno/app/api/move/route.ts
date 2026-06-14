/**
 * POST /api/move — the gasless-move endpoint for UNO. The browser/bot POSTs the
 * player's pre-signed gameplay `SignedDelegation` plus the intended play; this
 * route forwards to `move()` in lib/game-backend.ts, which validates the play
 * against the full-rules engine and redeems the delegation through the
 * NexusDelegationManager (turn-bound, gasless for the player). Returns 200 on
 * success, 409 on a rule rejection (client retries), 500 on server error. No
 * wallet popup is involved — the single join-time delegation covers every move.
 */
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
