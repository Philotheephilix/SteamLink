/**
 * SERVER-ONLY in-process MONOPOLY driver.
 *
 * Ported from scripts/bots.ts, but it calls the game-backend functions DIRECTLY
 * (no HTTP) since it runs inside the same Next.js Node process as the singleton.
 * Each bot signs its OWN gameplay + budget delegations once with its OWN key, pays
 * the buy-in via game-backend.join, then loops: on its turn it decides a legal move
 * (lib/bot-strategy) and submits it via game-backend.act. Stops when state.winner is
 * set. Robust try/catch around each action (the engine retries on-chain).
 *
 * HUMAN AUTO-PILOT: the human seat is normally driven by the browser UI (roll → buy
 * → end). To guarantee the game ALWAYS progresses to a winner — even if the browser
 * is slow or a multi-step modal stalls — the runner also watches the human seat: if
 * it's the human's turn, the human has PAID, and the human has been idle past a grace
 * window, the backend plays ONE legal human action itself (roll/buy/end). This keeps
 * the on-chain full game flowing without the test having to perfectly click through
 * every modal. The human's own browser clicks still take effect first when they land.
 *
 * NEVER import from a client component (it pulls in the relayer engine).
 */
import { privateKeyToAccount } from "viem/accounts";
import type { Address, Hex } from "@nexus/types";
import type { SignedDelegation } from "@nexus/core";
import { signBudgetDelegation, signGameplayDelegation } from "./engine";
import { deployment } from "./deployment";
import { ENTRY_FEE_USDC } from "./config";
import { decideBotAction } from "./bot-strategy";
import type { GameSnapshot } from "./monopoly-rules";
import { act, join, snapshotState } from "./game-backend";
import type { PlayerKey } from "./ensure-players";

const PER_ACTION_CAP = process.env.PER_ACTION_CAP ?? "0.3";
const TOTAL_CAP = process.env.TOTAL_CAP ?? "5";
const FEE = process.env.ENTRY_FEE ?? ENTRY_FEE_USDC;
// Grace window: how long the human seat may sit idle on its turn before the backend
// auto-pilots one legal action for it (keeps the full game flowing for the demo).
const HUMAN_IDLE_GRACE_MS = Number(process.env.HUMAN_IDLE_GRACE_MS ?? 12_000);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface BotCtx extends PlayerKey {
  signedGameplay: SignedDelegation;
  signedBudget: SignedDelegation;
  joined: boolean;
}

/** Map the public snapshot into the GameSnapshot shape bot-strategy reads. */
function toSnapshot(st: any): GameSnapshot {
  const properties: GameSnapshot["properties"] = {};
  for (const [k, v] of Object.entries(st.properties ?? {})) properties[Number(k)] = v as any;
  return {
    roomId: st.roomId,
    players: (st.players ?? []).map((p: any) => ({
      id: p.address.toLowerCase(), name: p.name, role: p.role, cash: p.cash, position: p.position,
      inJail: p.inJail, jailTurns: 0, getOutCards: p.getOutCards ?? 0, bankrupt: p.bankrupt,
    })),
    properties,
    order: (st.players ?? []).map((p: any) => p.address.toLowerCase()),
    turnIndex: 0,
    round: st.round ?? 1,
    doublesCount: 0,
    pending: st.pending ?? null,
    rolledThisTurn: st.rolledThisTurn ?? false,
    winner: st.winner ?? null,
    cardLog: st.cardLog ?? [],
  };
}

/** Decide ONE legal action for any seat (bot or human auto-pilot) from the snapshot. */
function decideAction(snap: GameSnapshot, id: string): { action: string; spaceId?: number } {
  const d = decideBotAction(snap, id.toLowerCase());
  switch (d.kind) {
    case "payJail": return { action: "payJail" };
    case "roll": return { action: "roll" };
    case "buy": return { action: "buy" };
    case "decline": return { action: "decline" };
    case "build": return { action: "build", spaceId: d.spaceId };
    case "end": default: return { action: "end" };
  }
}

/**
 * Run the driver for the given bots + the human seat against the current game. Returns
 * when the game has a winner or the deadline passes. Launched as a long-lived
 * in-process task by auto-start (don't await it there).
 */
export async function runDriver(human: PlayerKey, bots: PlayerKey[], roomId: string): Promise<void> {
  console.log(`[bot-runner] ${bots.length} bot(s) + human auto-pilot for room ${roomId}`);

  // Per-bot: signed delegations (each with its OWN key) + entry-fee join.
  const botCtx: BotCtx[] = await Promise.all(
    bots.map(async (b) => {
      const account = privateKeyToAccount(b.privateKey);
      const signedGameplay = await signGameplayDelegation(account, BigInt(roomId));
      const signedBudget = await signBudgetDelegation(account, deployment.pot, PER_ACTION_CAP, TOTAL_CAP);
      return { ...b, signedGameplay, signedBudget, joined: false };
    }),
  );

  for (const b of botCtx) {
    try {
      const r = await join(b.address, b.signedGameplay, b.signedBudget);
      if (!r.ok) {
        console.warn(`[bot-runner] bot#${b.index} join skipped: ${(r.error ?? "").slice?.(0, 140) ?? r.error}`);
        continue;
      }
      b.joined = true;
      console.log(`[bot-runner] bot#${b.index} JOINED — buy-in ${FEE} USDC tx ${r.txHash}`);
    } catch (err) {
      console.warn(`[bot-runner] bot#${b.index} join error:`, err instanceof Error ? err.message : err);
    }
  }

  // The human seat's gameplay + budget delegations are cached server-side when the
  // browser pays the buy-in (game-backend.join). The auto-pilot below redeems those
  // same cached delegations, so it can only act once the human has actually joined.
  const humanId = human.address.toLowerCase();

  let humanTurnSince = 0; // ts the human's current turn began (for the idle grace)
  let lastHumanState = "";

  const DEADLINE = Date.now() + 40 * 60_000;
  while (Date.now() < DEADLINE) {
    const st = snapshotState();
    if (!st.ok) { await sleep(1500); continue; }
    if ((st as any).winner) {
      console.log(`[bot-runner] game over — winner ${(st as any).winner}; payout tx ${(st as any).payoutTx}`);
      return;
    }
    const current = ((st as any).currentTurn ?? null) as Address | null;

    // ── bot turn ──
    const bot = botCtx.find((b) => current && b.address.toLowerCase() === current.toLowerCase());
    if (bot) {
      const snap = toSnapshot(st);
      const { action, spaceId } = decideAction(snap, bot.address.toLowerCase());
      try {
        const r = await act(bot.address, action, spaceId);
        if ((r as any).winner || /already won|game over/i.test(r.error ?? "")) {
          console.log("[bot-runner] game over — stopping.");
          return;
        }
        if (!r.ok) { await sleep(1200); continue; }
        const dice = (r as any).dice ? ` ${(r as any).dice[0]}+${(r as any).dice[1]}` : "";
        console.log(`[bot-runner] bot#${bot.index} ${action}${dice} — ${((r as any).log ?? []).join("; ")}`);
      } catch (err) {
        console.log(`[bot-runner] bot#${bot.index} error:`, err instanceof Error ? err.message : err);
        await sleep(1200);
      }
      humanTurnSince = 0;
      await sleep(500);
      continue;
    }

    // ── human turn: give the browser a grace window, then auto-pilot ──
    if (current && current.toLowerCase() === humanId) {
      const humanSeat = (st as any).players?.find((p: any) => p.address.toLowerCase() === humanId);
      const paid = Boolean(humanSeat?.paid);
      // Fingerprint the human's turn state; reset the idle timer when it changes (a
      // browser click landed and advanced the rules), so we only auto-pilot true idle.
      const fp = JSON.stringify({ pos: humanSeat?.position, jail: humanSeat?.inJail, rolled: (st as any).rolledThisTurn, pending: (st as any).pending });
      if (fp !== lastHumanState) { lastHumanState = fp; humanTurnSince = Date.now(); }
      if (!humanTurnSince) humanTurnSince = Date.now();

      if (paid && Date.now() - humanTurnSince > HUMAN_IDLE_GRACE_MS) {
        const snap = toSnapshot(st);
        const { action, spaceId } = decideAction(snap, humanId);
        try {
          const r = await act(human.address as Address, action, spaceId);
          if (r.ok) {
            const dice = (r as any).dice ? ` ${(r as any).dice[0]}+${(r as any).dice[1]}` : "";
            console.log(`[bot-runner] HUMAN auto-pilot ${action}${dice} — ${((r as any).log ?? []).join("; ")}`);
            lastHumanState = ""; // force re-fingerprint next tick
          }
          if ((r as any).winner) {
            console.log("[bot-runner] game over (human auto-pilot) — stopping.");
            return;
          }
        } catch (err) {
          console.log(`[bot-runner] human auto-pilot error:`, err instanceof Error ? err.message : err);
        }
      }
      await sleep(1200);
      continue;
    }

    // not a known seat's turn (lag) — wait.
    await sleep(1200);
  }
  console.log("[bot-runner] deadline reached without a winner.");
}
