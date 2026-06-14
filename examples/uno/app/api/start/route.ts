export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import type { Address } from "@nexus/types";
import { startGameForHuman } from "../../../lib/auto-start";
import { jsonResponse } from "../../../lib/json-response";

/**
 * Start a fresh game seated with the connected player's wallet (seat 0) + the
 * server-side bots. Called by the browser "Start game" button when the player's
 * address isn't already seated in the auto-started demo game.
 */
export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as { human?: Address };
  if (!body.human || !/^0x[0-9a-fA-F]{40}$/.test(body.human)) {
    return jsonResponse({ ok: false, error: "valid `human` address required" }, 400);
  }
  const res = await startGameForHuman(body.human);
  return jsonResponse(res, res.ok ? 200 : 500);
}
