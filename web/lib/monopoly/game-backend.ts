/**
 * SERVER-ONLY authoritative MONOPOLY game backend (singleton).
 *
 * This is the brain that used to live in scripts/server.ts. It holds the single
 * live game (full ruleset + ownership + cash + turn cursor) at GLOBAL scope, so
 * every Next.js Route Handler and the in-process bot-runner share ONE game instance
 * within the single Node server process.
 *
 * NEVER import this from a client component — it pulls in the relayer engine
 * (lib/engine.ts) and the hardcoded relayer key (lib/config.ts). Only the API route
 * handlers (app/api/*) and lib/auto-start.ts / lib/bot-runner.ts (both driven by
 * instrumentation at runtime) may import it.
 *
 * The handler bodies are MOVED, not rewritten — the rules engine (lib/monopoly-rules)
 * and the relayer redemption (lib/engine) are exactly as in scripts/server.ts.
 */
import type { SignedDelegation } from "@steamlink/core";
import type { Address, Hex } from "@steamlink/types";
import {
  type MonopolyEngine,
  advanceTurnAdmin,
  chargeFromPlayer,
  creditDeposit,
  getCurrentTurn,
  getEngine,
  openPot,
  recordBankrupt,
  redeemAction,
  redeemEndTurn,
  redeemRoll,
  settlePot,
  startTurns,
} from "./engine";
import { deployment } from "./deployment";
import { chargeViaGrant, type Erc7715GrantContext } from "./erc7715-settle";
import { DOLLAR_TO_USDC, dollarsToUsdc } from "./board";
import { MonopolyRules, ROUND_CAP, type Settlement } from "./monopoly-rules";
import { ENTRY_FEE_USDC } from "./config";

// ── single live game state ───────────────────────────────────────────────────
interface SeatDelegs {
  signedGameplay?: SignedDelegation;
  signedBudget?: SignedDelegation;
  paid: boolean;
}
interface Game {
  roomId: bigint;
  fee: string;
  rules: MonopolyRules;
  delegs: Record<string, SeatDelegs>; // player id (lc) → cached delegations
  names: Record<string, string>;
  payoutTx?: Hex;
  paymentTx: Record<string, Hex>;
  lastTx: Record<string, Hex>; // player → last settled tx
  settled: boolean;
}

/**
 * Next.js loads `instrumentation.ts` (the auto-start) and the API route handlers
 * in SEPARATE module registries, so a plain module-level `let game` would give
 * each context its OWN copy — the route handlers would never see the game the
 * instrumentation hook started (the bug that made /api/state report "no game").
 * Hoist ALL mutable singletons onto `globalThis` so every context in the single
 * Node server process shares ONE instance.
 */
interface MonopolyStore {
  game: Game | null;
  nextRoom: bigint;
  enginePromise: Promise<MonopolyEngine> | null;
  chain: Promise<unknown>;
  /** Per-player ERC-7715 spend grants (player addr → granted permission context). */
  grants: Map<Address, Erc7715GrantContext>;
}
const store: MonopolyStore = ((globalThis as unknown as { __nexusMonopolyStore?: MonopolyStore }).__nexusMonopolyStore ??= {
  game: null,
  // Full ms timestamp (not mod 1e6) so room IDs are unique + monotonic ACROSS
  // server restarts — `% 1_000_000` cycles every ~16min and collided with rooms
  // already opened on-chain (the pot reverts Pot_AlreadyOpen on re-open).
  nextRoom: BigInt(Date.now()),
  enginePromise: null,
  chain: Promise.resolve(),
  grants: new Map<Address, Erc7715GrantContext>(),
});

function engine(): Promise<MonopolyEngine> {
  if (!store.enginePromise) store.enginePromise = getEngine();
  return store.enginePromise;
}

// Serialize ALL relayer submissions (single key → sequential nonces).
function serialized<T>(fn: () => Promise<T>): Promise<T> {
  const run = store.chain.then(fn, fn);
  store.chain = run.then(() => undefined, () => undefined);
  return run;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Retry a relayer submission a few times on a transient nonce/relayer collision
 *  (the relayer key is shared with the UNO example). */
async function withNonceRetry<T>(fn: () => Promise<T>, tries = 4): Promise<T> {
  let last: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      const m = (e instanceof Error ? e.message : String(e)).toLowerCase();
      if (!/nonce|replacement|already known|mempool/.test(m) || i >= tries - 1) throw e;
      await sleep(1200 * (i + 1));
    }
  }
  throw last instanceof Error ? last : new Error(String(last));
}

function reviveSigned(s: SignedDelegation): SignedDelegation {
  return { ...s, salt: BigInt(s.salt as unknown as string | bigint), maxRedemptions: BigInt(s.maxRedemptions as unknown as string | bigint) };
}

function publicGame(g: Game, currentTurn: Address | null) {
  const snap = g.rules.snapshot();
  // When no on-chain turn is supplied (snapshotState / tight bot loop), fall back to the
  // rules-engine's authoritative current player (it skips bankrupt seats; the on-chain
  // strict rotation doesn't). The bot-runner relies on this to know whose turn it is.
  const turn = currentTurn ?? (g.rules.winner ? null : ((g.rules.current()?.id ?? null) as Address | null));
  return {
    roomId: g.roomId.toString(),
    fee: g.fee,
    pot: deployment.pot,
    currentTurn: turn,
    winner: snap.winner,
    payoutTx: g.payoutTx ?? null,
    round: snap.round,
    roundCap: ROUND_CAP,
    dollarToUsdc: DOLLAR_TO_USDC,
    pending: snap.pending,
    rolledThisTurn: snap.rolledThisTurn,
    players: snap.players.map((p) => ({
      address: p.id,
      name: p.name,
      role: p.role,
      cash: p.cash,
      position: p.position,
      inJail: p.inJail,
      getOutCards: p.getOutCards,
      bankrupt: p.bankrupt,
      netWorth: g.rules.netWorth(p.id),
      properties: g.rules.ownedBy(p.id),
      paid: g.delegs[p.id]?.paid ?? false,
      lastTx: g.lastTx[p.id] ?? null,
    })),
    properties: snap.properties,
    cardLog: snap.cardLog,
  };
}

/**
 * Settle one engine settlement on-chain. A debit FROM a player is a real USDC x402
 * charge → Pot (bounded by the player's budget delegation), credited to the eventual
 * winner. Credits FROM the bank (GO bonus, mortgage, house sale) are play-money only.
 * Returns the tx hash of the real charge, if any.
 */
async function settleOnChain(e: MonopolyEngine, g: Game, s: Settlement): Promise<Hex | null> {
  if (s.from === "bank") return null;
  if (s.amount <= 0) return null;
  const fromId = s.from.toLowerCase();
  const seat = g.delegs[fromId];
  // Only a player who joined (cached a budget delegation AND paid the buy-in) can be
  // charged real USDC; bots/observers without a funded budget play money-free.
  if (!seat?.signedBudget || !seat.paid) return null; // unfunded/observer — skip real charge
  const amountUsdc = dollarsToUsdc(s.amount);
  if (Number(amountUsdc) <= 0) return null;
  const res = await withNonceRetry(() =>
    chargeFromPlayer(e, seat.signedBudget!, fromId as Address, deployment.pot, amountUsdc),
  );
  g.lastTx[fromId] = res.txHash;
  return res.txHash;
}

// ── public API ───────────────────────────────────────────────────────────────

export function health() {
  return { ok: true, world: deployment.world, pot: deployment.pot, usdc: deployment.usdc, randomness: deployment.randomness };
}

/** True once a game exists and is seated. */
export function hasGame(): boolean {
  return store.game !== null;
}

export async function getState(): Promise<{ ok: boolean; error?: string; currentTurn?: Address | null; winner?: string | null; payoutTx?: Hex | null } & Record<string, unknown>> {
  if (!store.game) return { ok: false, error: "no game" };
  const g = store.game;
  let cur: Address | null = null;
  try {
    const e = await engine();
    cur = await getCurrentTurn(e, g.roomId);
  } catch {
    /* lag */
  }
  return { ok: true, ...publicGame(g, cur) };
}

/** Synchronous snapshot (no on-chain read) — for tight bot loops. */
export function snapshotState(): { ok: boolean } & Record<string, unknown> {
  if (!store.game) return { ok: false, error: "no game" };
  return { ok: true, ...publicGame(store.game, null) };
}

/**
 * Idempotent: seat human + bots, start on-chain turns, open pot. Same logic as the
 * old /api/new-game. If a game already exists and `force` is not set, it returns the
 * existing game (so double-invoke in dev doesn't reseat the table the human joined).
 */
export async function ensureGame(
  human: Address,
  bots: Address[],
  fee: string = ENTRY_FEE_USDC,
  force = false,
): Promise<{ ok: boolean; error?: string; roomId?: string } & Record<string, unknown>> {
  if (store.game && !force) return { ok: true, ...publicGame(store.game, null), reused: true };

  const e = await engine();
  const order: Address[] = [human, ...bots];
  try {
    const roomId = await serialized(async () => {
      const id = store.nextRoom++;
      await startTurns(e, id, order);
      await openPot(e, id);
      return id;
    });
    const seats = order.map((a, i) => ({ id: a, name: i === 0 ? "You" : `Bot ${i}`, role: (i === 0 ? "human" : "bot") as "human" | "bot" }));
    const rules = new MonopolyRules(roomId.toString(), seats);
    store.game = {
      roomId,
      fee,
      rules,
      delegs: Object.fromEntries(order.map((a) => [a.toLowerCase(), { paid: false } as SeatDelegs])),
      names: Object.fromEntries(seats.map((s) => [s.id.toLowerCase(), s.name])),
      paymentTx: {},
      lastTx: {},
      settled: false,
    };
    console.log(`[monopoly-backend] NEW GAME room ${roomId} — ${order.length} players, full rules, win = last solvent.`);
    return { ok: true, ...publicGame(store.game, null), roomId: roomId.toString() };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Join: cache the player's delegations + pay the x402 buy-in (USDC → Pot). The human
 * route handler and the in-process bot-runner both call this.
 */
export async function join(
  player: Address,
  signedGameplay: SignedDelegation,
  signedBudget: SignedDelegation,
): Promise<{ ok: boolean; txHash?: Hex; alreadyPaid?: boolean; error?: string } & Record<string, unknown>> {
  if (!store.game) return { ok: false, error: "no game" };
  const g = store.game;
  const id = player.toLowerCase();
  const seat = g.delegs[id];
  if (!seat) return { ok: false, error: "not a seat" };
  seat.signedGameplay = reviveSigned(signedGameplay);
  seat.signedBudget = reviveSigned(signedBudget);
  if (seat.paid) return { ok: true, txHash: g.paymentTx[id], alreadyPaid: true, ...publicGame(g, null) };

  const e = await engine();
  try {
    const res = await serialized(async () => {
      const charge = await withNonceRetry(() => chargeFromPlayer(e, seat.signedBudget!, player, deployment.pot, g.fee));
      await withNonceRetry(() => creditDeposit(e, g.roomId, player, g.fee));
      return charge;
    });
    seat.paid = true;
    g.paymentTx[id] = res.txHash;
    console.log(`[monopoly-backend] ${g.names[id]} BUY-IN ${g.fee} USDC tx ${res.txHash}`);
    return { ok: true, txHash: res.txHash, ...publicGame(g, null) };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Store a player's ERC-7715 spend grant (the MetaMask native-popup authorization).
 * The granted `context` is later redeemed via the CANONICAL MetaMask
 * DelegationManager to charge the buy-in (see joinViaGrant). One grant per player.
 */
export function storeGrant(
  player: Address,
  grant: Erc7715GrantContext,
): { ok: boolean; error?: string } {
  if (!grant.context || !grant.context.startsWith("0x")) {
    return { ok: false, error: "missing or malformed granted permission context" };
  }
  store.grants.set(player.toLowerCase() as Address, {
    context: grant.context,
    from: grant.from,
  });
  console.log(
    `[monopoly-backend] stored ERC-7715 grant for ${player} from ${grant.from} (${(grant.context.length - 2) / 2} bytes)`,
  );
  return { ok: true };
}

/**
 * Buy-in via an ERC-7715 grant: cache the player's gameplay delegation (still
 * needed for gasless moves), then redeem the player's granted permission context
 * through the canonical MetaMask DelegationManager — a real USDC transfer from
 * their MetaMask smart account to the Pot. This is the MetaMask/intuitive-popup
 * counterpart of `join()` (which redeems our custom budget delegation for guests).
 */
export async function joinViaGrant(
  player: Address,
  signedGameplay: SignedDelegation,
): Promise<{ ok: boolean; txHash?: Hex; alreadyPaid?: boolean; error?: string } & Record<string, unknown>> {
  if (!store.game) return { ok: false, error: "no game" };
  const g = store.game;
  const id = player.toLowerCase();
  const seat = g.delegs[id];
  if (!seat) return { ok: false, error: "not a seat" };
  seat.signedGameplay = reviveSigned(signedGameplay);
  if (seat.paid) return { ok: true, txHash: g.paymentTx[id], alreadyPaid: true, ...publicGame(g, null) };

  const grant = store.grants.get(id as Address);
  if (!grant) return { ok: false, error: "no ERC-7715 grant on file — grant a spend permission first" };

  const e = await engine();
  try {
    const res = await serialized(async () => {
      const charged = await chargeViaGrant(grant, deployment.pot, g.fee);
      // Mirror the deposit into the Pot's accounting (same as the guest buy-in path).
      await withNonceRetry(() => creditDeposit(e, g.roomId, player, g.fee));
      return charged;
    });
    seat.paid = true;
    g.paymentTx[id] = res.txHash;
    console.log(`[monopoly-backend] ${g.names[id]} BUY-IN ${g.fee} USDC via ERC-7715 grant tx ${res.txHash}`);
    return { ok: true, txHash: res.txHash, ...publicGame(g, null) };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export interface ActOutcome {
  ok: boolean;
  dice?: [number, number];
  log?: string[];
  txHash?: Hex;
  recordTx?: Hex;
  winner?: string | null;
  error?: string;
  /** "rule" → caller should map to 409; "server" → 500. */
  reject?: "rule" | "server";
}

/** Run ONE action through the authoritative rules engine + settle it on-chain. */
export async function act(player: Address, action: string, spaceId?: number): Promise<ActOutcome & Record<string, unknown>> {
  if (!store.game) return { ok: false, error: "no game", reject: "rule" };
  const g = store.game;
  const id = player.toLowerCase();
  const seat = g.delegs[id];
  if (!seat) return { ok: false, error: "not a seat", reject: "rule" };
  if (g.rules.winner) return { ok: false, error: "game already won", winner: g.rules.winner, reject: "rule" };

  const e = await engine();
  try {
    const result = await serialized(() => runAction(e, g, id as Address, action, spaceId));
    let cur: Address | null = null;
    try { cur = await getCurrentTurn(e, g.roomId); } catch { /* lag */ }
    return { ok: true, ...result, ...publicGame(g, cur) };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const m = msg.toLowerCase();
    const ruleReject =
      m.includes("not your turn") || m.includes("already won") || m.includes("no pending") ||
      m.includes("not a seat") || m.includes("notyourturn") || m.includes("turn-bound") ||
      m.includes("game over") || m.includes("nonce");
    return { ok: false, error: msg, reject: ruleReject ? "rule" : "server" };
  }
}

/**
 * Apply one action for `player` and settle every resulting money movement on-chain.
 * MUST be called inside the serialized() queue.
 */
async function runAction(
  e: MonopolyEngine,
  g: Game,
  player: Address,
  action: string,
  spaceId?: number,
): Promise<{ dice?: [number, number]; log: string[]; txHash?: Hex; recordTx?: Hex }> {
  const rules = g.rules;
  const seat = g.delegs[player.toLowerCase()];
  const cur = rules.current();
  if (cur.id !== player.toLowerCase()) throw new Error(`not your turn (current ${cur.id})`);

  let dice: [number, number] | undefined;
  let settlements: Settlement[] = [];
  let log: string[] = [];
  let recordTx: Hex | undefined;
  let actionTagStr = action;
  let actionSpace = spaceId ?? cur.position;
  let actionAmount = 0n;

  switch (action) {
    case "roll": {
      if (!seat?.signedGameplay) throw new Error("no gameplay delegation (join first)");
      const onchain = await getCurrentTurn(e, g.roomId);
      if (onchain.toLowerCase() !== player.toLowerCase()) throw new Error(`not your turn (current ${onchain})`);
      const roll = await redeemRoll(e, seat.signedGameplay, g.roomId);
      recordTx = roll.txHash;
      const r = rules.roll(roll.die1, roll.die2);
      dice = [roll.die1, roll.die2];
      settlements = r.settlements;
      log = r.log;
      console.log(`[monopoly-backend] ${g.names[player.toLowerCase()]} ROLLED ${roll.die1}+${roll.die2} tx ${roll.txHash} — ${log.join("; ")}`);
      break;
    }
    case "buy": {
      actionSpace = cur.position;
      const r = rules.buy();
      settlements = r.settlements;
      log = r.log;
      actionTagStr = "buy";
      break;
    }
    case "decline": { const r = rules.decline(); log = r.log; break; }
    case "build": { const r = rules.build(spaceId!); settlements = r.settlements; log = r.log; actionTagStr = "build"; actionSpace = spaceId!; break; }
    case "mortgage": { const r = rules.mortgage(spaceId!); settlements = r.settlements; log = r.log; actionTagStr = "mortgage"; actionSpace = spaceId!; break; }
    case "unmortgage": { const r = rules.unmortgage(spaceId!); settlements = r.settlements; log = r.log; actionTagStr = "unmortgage"; actionSpace = spaceId!; break; }
    case "payJail": { const r = rules.payJail(); settlements = r.settlements; log = r.log; actionTagStr = "jail"; break; }
    case "end": {
      const adv = rules.endTurn();
      log = [`${g.names[player.toLowerCase()]} ended their turn`];
      await afterStateChange(e, g);
      if (rules.winner) {
        await maybeSettleWinner(e, g);
        return { log, recordTx };
      }
      console.log(`[monopoly-backend] END ${g.names[player.toLowerCase()]} sameTurn=${adv.sameTurn} next=${adv.nextPlayer ? g.names[adv.nextPlayer] : "none"}`);
      // Doubles let a player roll again (sameTurn) → no advance. Otherwise record the
      // end-turn on-chain and roll the on-chain cursor forward to the next solvent seat.
      if (!adv.sameTurn) {
        // Only redeem endTurn while the chain STILL shows this player as current —
        // otherwise the turn-bound gameplay caveat would reject it.
        const onchain = await getCurrentTurn(e, g.roomId).catch(() => null);
        if (onchain && onchain.toLowerCase() === player.toLowerCase() && seat?.signedGameplay) {
          await withNonceRetry(() => redeemEndTurn(e, seat.signedGameplay!, g.roomId)).then((r) => (recordTx = r.txHash)).catch((err) => {
            console.warn(`[monopoly-backend] endTurn redeem failed: ${err instanceof Error ? err.message : err}`);
          });
        }
        await syncOnChainTurn(e, g, adv.nextPlayer);
        const after = await getCurrentTurn(e, g.roomId).catch(() => null);
        console.log(`[monopoly-backend] END advanced on-chain → ${after}`);
      }
      return { log, recordTx };
    }
    default:
      throw new Error(`unknown action: ${action}`);
  }

  // Settle every money movement on-chain (real USDC charges for player debits).
  let chargeTx: Hex | undefined;
  for (const s of settlements) {
    const tx = await settleOnChain(e, g, s).catch((err) => {
      console.warn(`[monopoly-backend] settle skipped (${s.reason}): ${err instanceof Error ? err.message : err}`);
      return null;
    });
    if (tx && !chargeTx) chargeTx = tx;
  }

  // Record the action on-chain via the player's gameplay delegation (turn-bound,
  // gasless) — skip for "roll" (rollAndMove already recorded it).
  if (action !== "roll" && seat?.signedGameplay) {
    // Record the player's own debit for this action on-chain, in USDC base units
    // (6 decimals → ×1e6). Only the amount the acting player paid is logged.
    actionAmount = BigInt(settlements.find((s) => s.from === player.toLowerCase())?.amount ?? 0) * 1_000_000n;
    await recordPlayerAction(e, g, player, actionTagStr, actionSpace, actionAmount).then((t) => (recordTx = recordTx ?? t)).catch(() => {});
  }

  await afterStateChange(e, g);
  if (rules.winner) await maybeSettleWinner(e, g);

  return { dice, log, txHash: chargeTx, recordTx };
}

/** Advance the on-chain TurnManager until its current player matches the rules-engine's
 *  next player — skipping bankrupt seats the on-chain strict rotation would land on. */
async function syncOnChainTurn(e: MonopolyEngine, g: Game, target: string | null): Promise<void> {
  if (!target) return;
  for (let i = 0; i < g.rules.order.length + 1; i++) {
    const cur = await getCurrentTurn(e, g.roomId).catch(() => null);
    if (!cur) return;
    if (cur.toLowerCase() === target.toLowerCase()) return;
    await withNonceRetry(() => advanceTurnAdmin(e, g.roomId)).catch(() => {});
  }
}

async function recordPlayerAction(e: MonopolyEngine, g: Game, player: Address, tag: string, spaceId: number, amount: bigint): Promise<Hex | undefined> {
  const seat = g.delegs[player.toLowerCase()];
  if (!seat?.signedGameplay) return undefined;
  const onchain = await getCurrentTurn(e, g.roomId).catch(() => null);
  if (!onchain || onchain.toLowerCase() !== player.toLowerCase()) return undefined;
  const res = await withNonceRetry(() => redeemAction(e, seat.signedGameplay!, g.roomId, tag, spaceId, amount)).catch(() => null);
  return res?.txHash;
}

async function afterStateChange(e: MonopolyEngine, g: Game): Promise<void> {
  const snap = g.rules.snapshot();
  for (const p of snap.players) {
    if (!p.bankrupt) continue;
    // Record each bankruptcy on-chain exactly once: a `bankrupt:<id>` sentinel in
    // lastTx guards against re-recording on every subsequent state change.
    if (g.lastTx[`bankrupt:${p.id}`]) continue;
    g.lastTx[`bankrupt:${p.id}`] = "0x" as Hex;
    await withNonceRetry(() => recordBankrupt(e, g.roomId, p.id as Address)).catch(() => {});
    console.log(`[monopoly-backend] BANKRUPT ${g.names[p.id]} (round ${snap.round})`);
  }
}

async function maybeSettleWinner(e: MonopolyEngine, g: Game): Promise<void> {
  if (g.settled || !g.rules.winner) return;
  g.settled = true; // claim the settle slot up-front so concurrent acts can't double-pay
  const winner = g.rules.winner as Address;
  const eliminated = g.rules.players.filter((p) => p.bankrupt).map((p) => g.names[p.id]);
  try {
    const tx = await withNonceRetry(() => settlePot(e, g.roomId, winner));
    g.payoutTx = tx;
    console.log(`[monopoly-backend] ===== WINNER ${g.names[winner.toLowerCase()]} (${winner}) — eliminated: ${eliminated.join(", ") || "none (round cap)"} — POT PAID OUT tx ${tx} =====`);
  } catch (err) {
    g.settled = false;
    console.error(`[monopoly-backend] settle failed:`, err instanceof Error ? err.message : err);
    throw err;
  }
}
