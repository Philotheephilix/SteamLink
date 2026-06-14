/**
 * SERVER-ONLY auto-start. Invoked from instrumentation.ts's register() at RUNTIME
 * ONLY (NEXT_RUNTIME === "nodejs"), never at build/import time.
 *
 * On boot it:
 *   1. ensures the players exist + are funded (lib/ensure-players.ensurePlayers),
 *   2. reads the human (seat-0) + bot keys,
 *   3. calls game-backend.ensureGame() to seat the room (human seat 0 + bots) +
 *      open the pot on-chain,
 *   4. starts the in-process bot-runner driver as a long-lived async task (it joins
 *      the bots, plays them, and auto-pilots the human seat if the browser stalls).
 *
 * Idempotent via a module-level guard so Next's double-invoke in dev doesn't start
 * two games / two loops. Wrapped in try/catch — a slow chain logs + retries but never
 * crashes the server.
 *
 * A bounded game (human + 1 bot) reaches a real last-solvent finish within the demo
 * budget; override with BOT_COUNT / MONOPOLY_BOTS.
 *
 * NEVER import from a client component.
 */
import type { Address, Hex } from "@nexus/types";
import { ensurePlayers, readPlayers, type PlayerKey } from "./ensure-players";
import { ensureGame, getState } from "./game-backend";
import { runDriver } from "./bot-runner";

let started = false;

/**
 * Start a FRESH game seated with a REAL connected player (their wallet address) as
 * seat 0, plus the server-side bots, and launch the in-process driver. This powers
 * the browser "Start a game" button: a MetaMask/guest player whose address is not the
 * demo's auto-seeded human gets their own seat. Re-seating (force) replaces any
 * existing game; the previous driver loop stops itself when the room changes.
 *
 * The connecting wallet's key never reaches the server — only its address. The driver
 * only uses `human.address` (to auto-pilot the seat by redeeming the gameplay/budget
 * delegations the browser caches when it pays the buy-in), so a synthetic PlayerKey
 * carrying just the address is sufficient.
 */
export async function startGameForHuman(
  human: Address,
): Promise<{ ok: boolean; error?: string; roomId?: string } & Record<string, unknown>> {
  const players = await ensurePlayerKeys();
  let bots = players.filter((p) => p.role === "bot");
  const maxBots = process.env.MONOPOLY_BOTS ? Number(process.env.MONOPOLY_BOTS) : 1;
  bots = bots.slice(0, maxBots);
  if (bots.length === 0) return { ok: false, error: "no bots configured" };
  const game = await ensureGame(human, bots.map((b) => b.address), undefined, true);
  if (!game.ok) return game;
  const roomId = String((game as { roomId?: string }).roomId);
  const humanSeat: PlayerKey = { role: "human", index: 0, privateKey: ("0x" as Hex), address: human };
  console.log(`[start] seated player ${human} in room ${roomId}; launching ${bots.length} bot(s)`);
  void runDriver(humanSeat, bots, roomId).catch((err) =>
    console.error("[start] bot-runner crashed:", err instanceof Error ? err.message : err),
  );
  return game;
}

async function ensurePlayerKeys(): Promise<PlayerKey[]> {
  try {
    return await ensurePlayers();
  } catch (err) {
    const existing = readPlayers();
    if (existing && existing.length > 0) {
      console.warn("[auto-start] ensurePlayers failed; using existing players.local.json:", err instanceof Error ? err.message : err);
      return existing;
    }
    throw err;
  }
}

export async function startAutoGame(): Promise<void> {
  if (started) return;
  started = true;

  try {
    console.log("[auto-start] booting MONOPOLY game (players → game → bots)…");

    const players = await ensurePlayerKeys();
    const human = players.find((p) => p.role === "human");
    let bots = players.filter((p) => p.role === "bot");
    // A bounded 2-player game (human + 1 bot) reaches a real bankruptcy finish in the
    // demo budget. Override with MONOPOLY_BOTS.
    const maxBots = process.env.MONOPOLY_BOTS ? Number(process.env.MONOPOLY_BOTS) : 1;
    bots = bots.slice(0, maxBots);
    if (!human || bots.length === 0) throw new Error("players.local.json needs a human + ≥1 bot");
    console.log(`[auto-start] human seat ${human.address}; ${bots.length} bot(s)`);

    const game = await ensureGame(human.address, bots.map((b) => b.address));
    if (!game.ok) throw new Error(`ensureGame failed: ${game.error}`);
    const roomId = String((game as { roomId?: string }).roomId ?? (await getState() as { roomId?: string }).roomId);
    console.log(`[auto-start] game room ${roomId} ready.`);

    void runDriver(human, bots, roomId).catch((err) => {
      console.error("[auto-start] bot-runner crashed:", err instanceof Error ? err.message : err);
    });

    console.log("[auto-start] up. Human connects in the browser at the same origin.");
  } catch (err) {
    started = false;
    console.error("[auto-start] failed (will allow retry):", err instanceof Error ? err.message : err);
  }
}
