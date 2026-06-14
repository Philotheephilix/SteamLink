export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { health } from "../../../lib/game-backend";
import { jsonResponse } from "../../../lib/json-response";

export async function GET() {
  return jsonResponse(health());
}
