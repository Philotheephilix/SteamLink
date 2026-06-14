/**
 * SERVER-ONLY in-process bot runner.
 *
 * Ported from scripts/bots.ts, but it calls the game-backend functions DIRECTLY
 * (no HTTP) since it runs inside the same Next.js Node process as the singleton.
 * Each bot signs its OWN gameplay + budget delegations once with its OWN key,
 * pays the buy-in via game-backend.charge, then loops: on its turn it decides a
 * legal move (lib/bot-strategy) and submits it via game-backend.move. Stops when
 * state.winner is set. Robust try/catch around each action (the engine retries
 * on-chain).
 *
 * NEVER import from a client component (it pulls in the relayer engine).
 */
import { privateKeyToAccount } from "viem/accounts";
import type { Address } from "@nexus/types";
import type { SignedDelegation } from "@nexus/core";
import { signBudgetDelegation, signGameplayDelegation } from "./engine";
import { deployment } from "./deployment";
import { type UnoCard, type TopState, cardLabel } from "./uno-rules";
import { chooseBotMove } from "./bot-strategy";
import { ENTRY_FEE_USDC } from "./config";
import { charge, getState, move, revealHand } from "./game-backend";
import type { PlayerKey } from "./ensure-players";

const PER_ACTION_CAP = process.env.PER_ACTION_CAP ?? "1";
const TOTAL_CAP = process.env.TOTAL_CAP ?? "2";
const FEE = process.env.ENTRY_FEE ?? ENTRY_FEE_USDC;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface BotCtx extends PlayerKey {
  signedGameplay: SignedDelegation;
  signedBudget: SignedDelegation;
  paid: boolean;
}

/**
 * Run the bot loop for the given bots against the current game (roomId). Returns
 * when the game has a winner or the deadline passes. Designed to be launched as a
 * long-lived in-process task by auto-start (don't await it there).
 */
export async function runBots(bots: PlayerKey[], roomId: string): Promise<void> {
  if (bots.length === 0) {
    console.log("[bot-runner] no bots to run");
    return;
  }
  console.log(`[bot-runner] ${bots.length} bot(s) for room ${roomId}`);

  // Per-bot: signed delegations (each with its OWN key) + entry-fee charge.
  const botCtx: BotCtx[] = await Promise.all(
    bots.map(async (b) => {
      const account = privateKeyToAccount(b.privateKey);
      const signedGameplay = await signGameplayDelegation(account, BigInt(roomId));
      const signedBudget = await signBudgetDelegation(account, deployment.pot, PER_ACTION_CAP, TOTAL_CAP);
      return { ...b, signedGameplay, signedBudget, paid: false };
    }),
  );

  for (const b of botCtx) {
    try {
      const r = await charge(b.address, b.signedBudget);
      if (!r.ok) {
        console.warn(`[bot-runner] bot#${b.index} entry-fee charge skipped: ${r.error?.slice?.(0, 120) ?? r.error}`);
        continue;
      }
      b.paid = true;
      console.log(`[bot-runner] bot#${b.index} PAID ${FEE} USDC — tx ${r.txHash}`);
    } catch (err) {
      console.warn(`[bot-runner] bot#${b.index} charge error:`, err instanceof Error ? err.message : err);
    }
  }

  // Play loop.
  const DEADLINE = Date.now() + 12 * 60_000;
  while (Date.now() < DEADLINE) {
    const st = getState();
    if (!st.ok) {
      await sleep(1500);
      continue;
    }
    if (st.winner) {
      console.log(`[bot-runner] game over — winner ${st.winner}; payout tx ${st.payoutTx}`);
      return;
    }
    const current = (st.currentTurn ?? null) as Address | null;
    const bot = botCtx.find((b) => current && b.address.toLowerCase() === current.toLowerCase());
    if (!bot) {
      await sleep(1200);
      continue; // human's (or another bot's) turn
    }

    try {
      const handRes = await revealHand(bot.address);
      if (!handRes.ok || !handRes.hand) {
        await sleep(1200);
        continue;
      }
      const hand = handRes.hand as UnoCard[];
      const top = (st.board ?? { topColor: 1, topValue: 5, activeColor: 1 }) as TopState;
      const chosen = chooseBotMove(hand, top);

      if (!chosen) {
        const r = await move(bot.address, bot.signedGameplay, "draw");
        if (!r.ok) {
          console.log(`[bot-runner] bot#${bot.index} draw rejected: ${r.error}`);
          await sleep(1200);
          continue;
        }
        console.log(`[bot-runner] bot#${bot.index} drew (${r.playable ? "playable" : "passed"})`);
        await sleep(600);
        continue;
      }

      const r = await move(bot.address, bot.signedGameplay, "play", chosen.card, chosen.chosenColor);
      if (!r.ok) {
        console.log(`[bot-runner] bot#${bot.index} play rejected: ${r.error}`);
        await sleep(1200);
        continue;
      }
      console.log(
        `[bot-runner] bot#${bot.index} played ${cardLabel(chosen.card)}${chosen.card.color === 0 ? ` → ${["", "red", "green", "blue", "yellow"][chosen.chosenColor ?? 0]}` : ""} (${hand.length - 1} left) — tx ${r.txHash}`,
      );
      if (r.winner) {
        console.log(`[bot-runner] WINNER ${r.winner}; payout tx ${r.payoutTx}`);
        return;
      }
    } catch (err) {
      console.log(`[bot-runner] bot#${bot.index} move error:`, err instanceof Error ? err.message : err);
      await sleep(1200);
    }
    await sleep(700);
  }
  console.log("[bot-runner] deadline reached without a winner.");
}
