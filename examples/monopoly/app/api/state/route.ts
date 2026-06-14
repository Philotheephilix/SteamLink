export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { getState } from "../../../lib/game-backend";
import { jsonResponse } from "../../../lib/json-response";

export async function GET() {
  const st = await getState();
  // The page polls this; a "no game yet" reply is 200 with ok:false (matches the old
  // standalone server) so the client treats it as transient, not a hard error.
  return jsonResponse(st, 200);
}
