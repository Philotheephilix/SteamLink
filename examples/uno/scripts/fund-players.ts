/**
 * Generate + fund the UNO player keys (1 human + N bots), SEQUENTIALLY.
 *
 * This is now a thin CLI wrapper over lib/ensure-players.ts (the reusable core
 * that lib/auto-start.ts also calls in-process). For each player the relayer
 * tops up ETH + USDC, then each player sends its own approve(manager). Writes
 * examples/uno/players.local.json (gitignored).
 *
 *   pnpm --filter @nexus/example-uno fund-players          # default 2 bots
 *   BOT_COUNT=3 USDC_EACH=0.5 ETH_EACH=0.0008 pnpm ... fund-players
 */
import { ensurePlayers } from "../lib/ensure-players";

async function main() {
  const players = await ensurePlayers();
  console.log("Human:", players[0].address);
  console.log("Bots:", players.filter((p) => p.role === "bot").map((p) => p.address).join(", "));
}

main().catch((e) => {
  console.error("[fund-players] fatal:", e);
  process.exit(1);
});
