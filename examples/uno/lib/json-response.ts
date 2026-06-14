/**
 * SERVER-ONLY: BigInt-safe NextResponse.json. Serializes any bigint in the body
 * to a decimal string so route handlers never throw on bigints.
 */
import { NextResponse } from "next/server";

export function jsonResponse(value: unknown, status = 200): NextResponse {
  const body = JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
  return new NextResponse(body, { status, headers: { "content-type": "application/json" } });
}
