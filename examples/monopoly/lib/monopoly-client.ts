/**
 * Browser-side Monopoly client for the full-rules game server (/api/*). The human
 * signs its OWN gameplay + budget delegation with the guest wallet (a viem
 * LocalAccount); the server caches them and redeems them via the relayer. The human
 * pays zero gas; every money debit (buy-in / buy / rent / tax / build / fine) is a
 * real USDC charge from the human's own wallet → Pot, bounded by the budget delegation.
 */
import type { Address, Hex } from "@nexus/types";
import type { LocalAccount } from "viem/accounts";
import { signBudgetDelegation, signGameplayDelegation } from "./delegations";

export interface PropertyView {
  spaceId: number;
  owner: string | null;
  houses: number;
  mortgaged: boolean;
}
export interface PlayerView {
  address: Address;
  name: string;
  role: "human" | "bot";
  cash: number;
  position: number;
  inJail: boolean;
  getOutCards: number;
  bankrupt: boolean;
  netWorth: number;
  properties: number[];
  paid: boolean;
  lastTx: Hex | null;
}
export type Pending =
  | { kind: "buy"; spaceId: number; price: number }
  | { kind: "pay"; to: string; amount: number; reason: string }
  | { kind: "end" }
  | null;
export interface GameView {
  ok: boolean;
  roomId: string;
  fee: string;
  pot: Address;
  currentTurn?: Address | null;
  winner: string | null;
  payoutTx: Hex | null;
  round: number;
  roundCap: number;
  dollarToUsdc: number;
  pending: Pending;
  rolledThisTurn: boolean;
  players: PlayerView[];
  properties: Record<number, PropertyView>;
  cardLog: string[];
}

// Caps that comfortably cover the human's buy-in + buys/rents/builds at the $1 =
// 0.0001 USDC scale (a $2000 hotel = 0.2 USDC).
const PER_ACTION_CAP = "0.3";
const TOTAL_CAP = "5";

export interface ActResult {
  ok: boolean;
  dice?: [number, number];
  log?: string[];
  txHash?: Hex;
  recordTx?: Hex;
  error?: string;
}

export class MonopolyClient {
  constructor(
    private readonly baseUrl: string,
    private readonly account: LocalAccount,
  ) {}

  get address(): Address {
    return this.account.address;
  }

  private async get<T>(path: string): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`);
    return res.json() as Promise<T>;
  }
  private async post<T>(path: string, body: unknown): Promise<T> {
    const payload = JSON.stringify(body, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
    const res = await fetch(`${this.baseUrl}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: payload });
    return res.json() as Promise<T>;
  }

  state(): Promise<GameView> {
    return this.get("/api/state");
  }

  /** Seat THIS wallet (seat 0) + the server bots and start a fresh game. */
  start(): Promise<{ ok: boolean; roomId?: string; error?: string }> {
    return this.post("/api/start", { human: this.address });
  }

  private budgetByPot = new Map<string, Awaited<ReturnType<typeof signBudgetDelegation>>>();
  private async budget(pot: Address) {
    let s = this.budgetByPot.get(pot.toLowerCase());
    if (!s) {
      s = await signBudgetDelegation(this.account, pot, PER_ACTION_CAP, TOTAL_CAP);
      this.budgetByPot.set(pot.toLowerCase(), s);
    }
    return s;
  }
  private gameplayByRoom = new Map<string, Awaited<ReturnType<typeof signGameplayDelegation>>>();
  private async gameplay(roomId: string) {
    let s = this.gameplayByRoom.get(roomId);
    if (!s) {
      s = await signGameplayDelegation(this.account, BigInt(roomId));
      this.gameplayByRoom.set(roomId, s);
    }
    return s;
  }

  /** Join: sign + submit both delegations and pay the x402 buy-in (real USDC → Pot). */
  async join(roomId: string, pot: Address): Promise<{ ok: boolean; txHash?: Hex; error?: string }> {
    const [signedGameplay, signedBudget] = await Promise.all([this.gameplay(roomId), this.budget(pot)]);
    return this.post("/api/join", { player: this.address, signedGameplay, signedBudget });
  }

  /** Run one action through the rules engine (roll / buy / decline / build / mortgage /
   *  unmortgage / payJail / end). The server redeems the cached delegations on-chain. */
  act(action: string, spaceId?: number): Promise<ActResult & GameView> {
    return this.post("/api/act", { player: this.address, action, spaceId });
  }
}
