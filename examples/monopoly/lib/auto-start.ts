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
import { ensurePlayers, readPlayers, type PlayerKey } from "./ensure-players";
import { ensureGame, getState } from "./game-backend";
import { runDriver } from "./bot-runner";

let started = false;

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
