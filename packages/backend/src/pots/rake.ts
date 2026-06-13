import type { EconomyConfig } from "@nexus/core";
import { NexusError } from "@nexus/types";

/**
 * Rake + pro-rata refund math (phase-05 §4.9). All amounts are decimal strings in
 * human (USDC) units to avoid float drift on the wire; internal math uses integer
 * micro-USDC (6 decimals) so winner payout + rake == pot exactly.
 */
const DECIMALS = 6n;
const SCALE = 10n ** DECIMALS;

function toMicro(human: string): bigint {
  const [whole, frac = ""] = human.split(".");
  const fracPadded = `${frac}000000`.slice(0, 6);
  return BigInt(whole || "0") * SCALE + BigInt(fracPadded || "0");
}

function fromMicro(micro: bigint): string {
  const whole = micro / SCALE;
  const frac = (micro % SCALE).toString().padStart(6, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : `${whole}`;
}

/** One whole unit in basis points (100% = 10_000 bps). */
const BPS_DENOMINATOR = 10_000n;

/**
 * Resolve the rake as an INTEGER number of basis points (bps) using pure string
 * parsing — a money ratio is never passed through `Number()` (M5). Accepts:
 *  - an integer bps string/number, e.g. "1000" or "250" (preferred, exact);
 *  - a decimal fraction string, e.g. "0.1" (back-compat) → converted to bps
 *    deterministically by string math (0.1 → 1000 bps), with at most 4 decimal
 *    places of precision (1 bps); extra precision is rejected, not rounded.
 * Returns bps in [0, 10000).
 */
export function rakeBps(economy: EconomyConfig | undefined): bigint {
  const raw = economy?.pot?.rake;
  if (raw === undefined || raw === null) return 0n;
  const bps = parseRakeBps(String(raw));
  if (bps < 0n || bps >= BPS_DENOMINATOR) {
    throw new NexusError("INVALID_CONFIG", `bad rake (${raw}) — must be in [0, 100%)`);
  }
  return bps;
}

/** Parse a rake config string to integer bps via string math (no float). */
function parseRakeBps(s: string): bigint {
  const trimmed = s.trim();
  if (trimmed === "") return 0n;
  // Integer form: a whole number of basis points.
  if (/^\d+$/.test(trimmed)) return BigInt(trimmed);
  // Decimal fraction form (back-compat): "0.1" === 1000 bps. bps = fraction * 1e4.
  const m = /^(\d*)\.(\d+)$/.exec(trimmed);
  if (!m) throw new NexusError("INVALID_CONFIG", `unparseable rake "${s}"`);
  const whole = m[1] ?? "";
  const frac = m[2] ?? "";
  if (frac.length > 4) {
    throw new NexusError(
      "INVALID_CONFIG",
      `rake "${s}" has finer than 1bp precision — express it as integer basis points`,
    );
  }
  // Scale the decimal to 4 fractional digits, then interpret as bps.
  const fracPadded = `${frac}0000`.slice(0, 4);
  return BigInt(whole || "0") * BPS_DENOMINATOR + BigInt(fracPadded || "0");
}

/**
 * @deprecated Use {@link rakeBps}. Kept for back-compat; returns the rake as a
 * float fraction derived from the exact bps (safe to display, never used in
 * money math).
 */
export function rakeFraction(economy: EconomyConfig | undefined): number {
  return Number(rakeBps(economy)) / Number(BPS_DENOMINATOR);
}

export interface PayoutSplit {
  winner: string;
  rake: string;
}

/** Winner gets pot minus rake; payout + rake == pot exactly. Pure bigint (M5). */
export function computePayout(potHuman: string, economy: EconomyConfig | undefined): PayoutSplit {
  const pot = toMicro(potHuman);
  const bps = rakeBps(economy);
  // rake = floor(pot * bps / 10000) — all integer math, no float ever touches a ratio.
  const rake = (pot * bps) / BPS_DENOMINATOR;
  const winner = pot - rake;
  return { winner: fromMicro(winner), rake: fromMicro(rake) };
}

export interface RefundShare {
  player: string;
  amount: string;
}

/**
 * Pro-rata refund of an abandoned pot: each participant gets their equal share of
 * the un-rake'd pot; the shares sum to the full pot (dust goes to the first).
 */
export function computeRefunds(potHuman: string, participants: string[]): RefundShare[] {
  if (participants.length === 0) return [];
  const pot = toMicro(potHuman);
  const base = pot / BigInt(participants.length);
  const remainder = pot - base * BigInt(participants.length);
  return participants.map((player, i) => ({
    player,
    amount: fromMicro(i === 0 ? base + remainder : base),
  }));
}
