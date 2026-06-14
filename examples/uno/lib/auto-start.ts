/**
 * SERVER-ONLY auto-start. Invoked from instrumentation.ts's register() at
 * RUNTIME ONLY (NEXT_RUNTIME === "nodejs"), never at build/import time.
 *
 * On boot it:
 *   1. ensures the players exist + are funded (lib/ensure-players.ensurePlayers;
 *      generates + funds players.local.json if missing/under-funded),
 *   2. reads the human (seat-0) + bot keys,
 *   3. calls game-backend.ensureGame() to create the game (human seat 0 + bots),
 *   4. starts the in-process bot-runner loop as a long-lived async task.
 *
 * Idempotent via a module-level guard so Next's double-invoke in dev doesn't
 * start two games / two loops. Wrapped in try/catch — a slow chain logs + retries
 * but never crashes the server.
 *
 * NEVER import from a client component.
 */
import { ensurePlayers, readPlayers, type PlayerKey } from "./ensure-players";
import { ensureGame, getState } from "./game-backend";
import { runBots } from "./bot-runner";

let started = false;

async function ensurePlayerKeys(): Promise<PlayerKey[]> {
  // Prefer funding (idempotent — only tops up below threshold). If funding fails
  // (e.g. relayer busy) but keys already exist on disk, fall back to those so the
  // game can still seat; the engine retries on-chain ops later.
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
    console.log("[auto-start] booting UNO game (players → game → bots)…");

    // 1) Players (1 human + N bots), funded + approved.
    const players = await ensurePlayerKeys();
    const human = players.find((p) => p.role === "human");
    const bots = players.filter((p) => p.role === "bot");
    if (!human || bots.length === 0) {
      throw new Error("players.local.json needs a human + ≥1 bot");
    }
    console.log(`[auto-start] human seat ${human.address}; ${bots.length} bot(s)`);

    // 2) Create the game (human seat 0 + bots). ensureGame is idempotent.
    const game = await ensureGame(human.address, bots.map((b) => b.address));
    if (!game.ok) throw new Error(`ensureGame failed: ${game.error}`);
    const roomId = String((game as { roomId?: string }).roomId ?? (getState() as { roomId?: string }).roomId);
    console.log(`[auto-start] game room ${roomId} ready (on-chain shuffle ${(game as { shuffleTx?: string }).shuffleTx}).`);

    // 3) Launch the bot loop as a long-lived in-process task (don't await).
    void runBots(bots, roomId).catch((err) => {
      console.error("[auto-start] bot-runner crashed:", err instanceof Error ? err.message : err);
    });

    console.log("[auto-start] up. Human connects in the browser at the same origin.");
  } catch (err) {
    // Never crash the server. Allow a later boot/request to retry.
    started = false;
    console.error("[auto-start] failed (will allow retry):", err instanceof Error ? err.message : err);
  }
}
