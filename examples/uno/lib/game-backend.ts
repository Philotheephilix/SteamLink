/**
 * SERVER-ONLY authoritative UNO game backend (singleton).
 *
 * This is the brain that used to live in scripts/server.ts. It holds the single
 * live game (deck + sealed hands + board + turn cursor) at MODULE scope, so every
 * Next.js Route Handler and the in-process bot-runner share ONE game instance
 * within the single Node server process.
 *
 * NEVER import this from a client component — it pulls in the relayer engine
 * (lib/engine.ts) and the hardcoded relayer key (lib/config.ts). Only the API
 * route handlers (app/api/*) and lib/auto-start.ts / lib/bot-runner.ts (both
 * driven by instrumentation at runtime) may import it.
 *
 * The handler bodies are MOVED, not rewritten — the rules engine (lib/uno-game),
 * the relayer redemption (lib/engine) and sealed hands (@nexus/secrets) are
 * exactly as before.
 */
import type { SignedDelegation } from "@nexus/core";
import { LocalSecrets, type Sealed, type AccessCondition } from "@nexus/secrets";
import type { Address, Hex } from "@nexus/types";
import {
  type UnoEngine,
  chargeEntryFee,
  creditDeposit,
  dealHand,
  getCurrentTurn,
  getEngine,
  openPot,
  randomShuffleWord,
  redeemMove,
  setTurnDirection,
  settlePot,
  startRoom,
  startTurns,
  waitForTurn,
} from "./engine";
import { deployment } from "./deployment";
import { UnoGame, HAND_SIZE } from "./uno-game";
import { type UnoCard, cardLabel, legalPlays } from "./uno-rules";
import { ENTRY_FEE_USDC } from "./config";

// ── Sealed-hand secrets layer (real AES-256-GCM) ─────────────────────────────
// `secrets` lives on the shared global store (below) so a hand sealed in the
// instrumentation (auto-start) context can be revealed in a route-handler context.
function ownerCondition(): AccessCondition[] {
  return [{ chain: "base-sepolia", method: "ownerOf", returns: { comparator: "=", value: ":userAddress" } }];
}
const enc = new TextEncoder();
const dec = new TextDecoder();

// ── single live game state ───────────────────────────────────────────────────
interface Seat {
  address: Address;
  role: "human" | "bot";
  paid: boolean;
}
interface GameState {
  roomId: bigint;
  fee: string;
  seats: Seat[];
  game: UnoGame;
  /** sealed hand blobs per player (real AES-GCM ciphertext) */
  sealed: Map<Address, Sealed>;
  shuffleTx: Hex;
  shuffleWord: bigint;
  winner?: Address;
  payoutTx?: Hex;
  startedPlay: boolean;
  paymentTx: Record<string, Hex>;
}

/**
 * Next.js loads `instrumentation.ts` (the auto-start) and the API route handlers
 * in SEPARATE module registries, so a plain module-level `let game` would give
 * each context its OWN copy — the route handlers would never see the game the
 * instrumentation hook started (the bug that made /api/state report "no game").
 * Hoist ALL mutable singletons onto `globalThis` so every context in the single
 * Node server process shares ONE instance (incl. `secrets`, so a hand sealed in
 * one context reveals in another).
 */
interface UnoStore {
  game: GameState | null;
  nextRoom: bigint;
  enginePromise: Promise<UnoEngine> | null;
  chain: Promise<unknown>;
  secrets: LocalSecrets;
}
const store: UnoStore = ((globalThis as unknown as { __nexusUnoStore?: UnoStore }).__nexusUnoStore ??= {
  game: null,
  // Full ms timestamp (not mod 1e6) so room IDs are unique + monotonic ACROSS
  // server restarts — `% 1_000_000` cycles every ~16min and collided with rooms
  // already opened on-chain (the pot reverts Pot_AlreadyOpen on re-open).
  nextRoom: BigInt(Date.now()),
  enginePromise: null,
  chain: Promise.resolve(),
  secrets: new LocalSecrets(),
});

// Engine is created lazily once (relayer wallet + ABIs).
function engine(): Promise<UnoEngine> {
  if (!store.enginePromise) store.enginePromise = getEngine();
  return store.enginePromise;
}

// Serialize ALL relayer submissions (single key → sequential nonces).
function serialized<T>(fn: () => Promise<T>): Promise<T> {
  const run = store.chain.then(fn, fn);
  store.chain = run.then(() => undefined, () => undefined);
  return run;
}

function reviveSigned(s: SignedDelegation): SignedDelegation {
  return {
    ...s,
    salt: BigInt(s.salt as unknown as string | bigint),
    maxRedemptions: BigInt(s.maxRedemptions as unknown as string | bigint),
  };
}

async function sealHand(hand: UnoCard[]): Promise<Sealed> {
  return store.secrets.seal(enc.encode(JSON.stringify(hand)), ownerCondition());
}
async function revealSealed(g: GameState, player: Address): Promise<UnoCard[]> {
  const sealed = g.sealed.get(player.toLowerCase() as Address);
  if (!sealed) return [];
  const bytes = await store.secrets.reveal(sealed, { caller: player, state: { ownerOf: player.toLowerCase() } });
  return JSON.parse(dec.decode(bytes)) as UnoCard[];
}
async function reseal(g: GameState, player: Address): Promise<void> {
  const addr = player.toLowerCase() as Address;
  g.sealed.set(addr, await sealHand(g.game.handOf(addr)));
}

function publicGame(g: GameState) {
  const t = g.game.topState();
  return {
    roomId: g.roomId.toString(),
    fee: g.fee,
    seats: g.seats.map((s) => ({ address: s.address, role: s.role, paid: s.paid, handCount: g.game.handCount(s.address) })),
    board: { topColor: t.topColor, topValue: t.topValue, activeColor: t.activeColor },
    direction: g.game.direction,
    winner: g.winner ?? null,
    payoutTx: g.payoutTx ?? null,
    startedPlay: g.startedPlay,
    pot: deployment.pot,
    shuffleTx: g.shuffleTx,
  };
}

// ── public API (the moved handler bodies) ────────────────────────────────────

export function health() {
  return { ok: true, world: deployment.world, pot: deployment.pot, usdc: deployment.usdc, randomness: deployment.randomness };
}

export function getState(): { ok: boolean; error?: string; currentTurn?: Address | null } & Record<string, unknown> {
  if (!store.game) return { ok: false, error: "no game" };
  return { ok: true, ...publicGame(store.game), currentTurn: store.game.game.currentPlayer() };
}

/** True once a game exists and is seated. */
export function hasGame(): boolean {
  return store.game !== null;
}

/**
 * Idempotent: seat human + bots, ON-CHAIN shuffle → deal → seal each hand → seed
 * board → open pot. Same logic as the old /api/new-game. If a game already exists
 * and `force` is not set, it returns the existing game (so double-invoke in dev
 * doesn't reshuffle the table the human already joined).
 */
export async function ensureGame(
  human: Address,
  bots: Address[],
  fee: string = ENTRY_FEE_USDC,
  force = false,
): Promise<{ ok: boolean; error?: string } & Record<string, unknown>> {
  if (store.game && !force) return { ok: true, ...publicGame(store.game), reused: true };

  const e = await engine();
  const order: Address[] = [human, ...bots];

  try {
    const result = await serialized(async () => {
      const roomId = store.nextRoom++;
      // 1) Draw a REAL on-chain random word and deal a full 108-card game from it.
      const { word, txHash: shuffleTx } = await randomShuffleWord(e);
      const ug = new UnoGame(order);
      ug.deal(word);
      // 2) Seat the turn order on-chain (human seat 0).
      await startTurns(e, roomId, order);
      // 3) Seed the public board to the real start card.
      const top = ug.top;
      await startRoom(e, roomId, top.color, top.value, HAND_SIZE);
      // 4) Record each seat's real hand count on-chain.
      for (const a of order) await dealHand(e, roomId, a, ug.handCount(a));
      // 5) Open the pot.
      await openPot(e, roomId);
      return { roomId, ug, shuffleTx, word };
    });

    const sealed = new Map<Address, Sealed>();
    for (const a of order) sealed.set(a.toLowerCase() as Address, await sealHand(result.ug.handOf(a)));

    store.game = {
      roomId: result.roomId,
      fee,
      seats: order.map((a, i) => ({ address: a, role: i === 0 ? "human" : "bot", paid: false })),
      game: result.ug,
      sealed,
      shuffleTx: result.shuffleTx,
      shuffleWord: result.word,
      startedPlay: false,
      paymentTx: {},
    };
    const top = result.ug.top;
    console.log(
      `[uno-backend] new game room ${result.roomId} seats ${order.length} — on-chain shuffle tx ${result.shuffleTx}, start card ${cardLabel(top)}`,
    );
    return { ok: true, ...publicGame(store.game) };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** x402 entry fee (unchanged proven rail). */
export async function charge(
  player: Address,
  signedBudget: SignedDelegation,
): Promise<{ ok: boolean; txHash?: Hex; blockNumber?: bigint; alreadyPaid?: boolean; error?: string }> {
  if (!store.game) return { ok: false, error: "no game" };
  const e = await engine();
  const g = store.game;
  const seat = g.seats.find((s) => s.address.toLowerCase() === player.toLowerCase());
  if (!seat) return { ok: false, error: "not a seat" };
  if (seat.paid) return { ok: true, txHash: g.paymentTx[seat.address], alreadyPaid: true };

  try {
    const budget = reviveSigned(signedBudget);
    const res = await serialized(async () => {
      const chargeRes = await chargeEntryFee(e, budget, player, deployment.pot, g.fee);
      await creditDeposit(e, g.roomId, player, g.fee);
      return chargeRes;
    });
    seat.paid = true;
    g.paymentTx[seat.address] = res.txHash;
    console.log(`[uno-backend] ${seat.role} ${seat.address} PAID ${g.fee} USDC tx ${res.txHash}`);
    return { ok: true, txHash: res.txHash, blockNumber: res.blockNumber };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Reveal the caller's OWN sealed hand (owner-gated) + legal-play indices. */
export async function revealHand(
  player: Address,
): Promise<{ ok: boolean; hand?: UnoCard[]; legal?: number[]; handCount?: number; error?: string }> {
  if (!store.game) return { ok: false, error: "no game" };
  const g = store.game;
  try {
    const hand = await revealSealed(g, player);
    const legal = legalPlays(hand, g.game.topState());
    return { ok: true, hand, legal, handCount: hand.length };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export interface MoveOutcome {
  ok: boolean;
  txHash?: Hex;
  board?: { topColor: number; topValue: number; activeColor: number };
  direction?: 1 | -1;
  winner?: Address | null;
  payoutTx?: Hex | null;
  playable?: boolean;
  error?: string;
  /** "rule" (illegal/turn) → caller should map to 409; "server" → 500. */
  reject?: "rule" | "server";
}

/** A gasless legal move: validate, mirror on-chain, reseal, settle on win. */
export async function move(
  player: Address,
  signedGameplay: SignedDelegation,
  kind: "play" | "draw",
  card?: UnoCard,
  chosenColor?: number,
): Promise<MoveOutcome> {
  if (!store.game) return { ok: false, error: "no game", reject: "rule" };
  const e = await engine();
  const g = store.game;
  if (g.winner) return { ok: false, error: "game already won", winner: g.winner, reject: "rule" };

  try {
    const out = await serialized(async () => {
      // On-chain turn guard (read-after-write tolerant).
      const ok = await waitForTurn(e, g.roomId, player, 3);
      if (!ok) {
        const cur = await getCurrentTurn(e, g.roomId);
        throw new Error(`not your turn (current ${cur})`);
      }

      if (kind === "play") {
        if (!card) throw new Error("card required for a play");
        // 1) Validate WITHOUT mutating (throws on illegal). Then commit + apply.
        g.game.validatePlay(player, card);
        const effect = g.game.play(player, card, chosenColor);
        const newCount = g.game.handCount(player);
        const activeColor = g.game.activeColor;
        const advanceBy = effect.skipped >= 1 ? 2 : 1;

        // 2) If direction flipped (Reverse, >2 players), reflect it on-chain first.
        if (effect.reversed && g.game.seats.length > 2) {
          await setTurnDirection(e, g.roomId, g.game.direction as 1 | -1);
        }

        // 3) Record the REAL card on-chain (gasless, turn-bound).
        const mv = await redeemMove(e, reviveSigned(signedGameplay), g.roomId, "play", {
          color: card.color,
          value: card.value,
          activeColor,
          newHandCount: newCount,
          advanceBy: newCount === 0 ? 1 : advanceBy,
        });

        // 4) Reseal the mover + any forced-draw target.
        await reseal(g, player);
        if (effect.forcedDrawTarget) await reseal(g, effect.forcedDrawTarget);

        g.startedPlay = true;
        const winner = mv.winner ?? (g.game.winner as Address | undefined);
        let payoutTx: Hex | undefined;
        if (winner) {
          g.winner = winner;
          payoutTx = await settlePot(e, g.roomId, winner);
          g.payoutTx = payoutTx;
          console.log(`[uno-backend] WINNER ${winner} — pot settled tx ${payoutTx}`);
        }
        return { txHash: mv.txHash, winner, payoutTx, playable: undefined as boolean | undefined };
      }

      // DRAW
      const { playable } = g.game.draw(player);
      const newCount = g.game.handCount(player);
      const advanceBy = playable ? 0 : 1;
      const mv = await redeemMove(e, reviveSigned(signedGameplay), g.roomId, "draw", { newHandCount: newCount, advanceBy });
      await reseal(g, player);
      g.startedPlay = true;
      return { txHash: mv.txHash, winner: undefined as Address | undefined, payoutTx: undefined as Hex | undefined, playable };
    });

    const t = g.game.topState();
    return {
      ok: true,
      txHash: out.txHash,
      board: { topColor: t.topColor, topValue: t.topValue, activeColor: t.activeColor },
      direction: g.game.direction,
      winner: out.winner ?? null,
      payoutTx: out.payoutTx ?? null,
      playable: out.playable,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const ruleReject = /NOT_YOUR_TURN|ILLEGAL_MOVE|CARD_NOT_IN_HAND|BAD_COLOR|already won|not your turn/.test(msg);
    return { ok: false, error: msg, reject: ruleReject ? "rule" : "server" };
  }
}
