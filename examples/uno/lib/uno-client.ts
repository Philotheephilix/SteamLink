/**
 * Browser-side UNO client for the new game server (/api/*). The human signs its
 * OWN delegations with the guest wallet (a viem LocalAccount); the server redeems
 * them via the relayer. The human pays zero gas; the entry fee is a real USDC
 * charge from the human's own wallet, bounded by the budget delegation.
 */
import type { Address, Hex } from "@nexus/types";
import type { LocalAccount } from "viem/accounts";
import type { UnoCard } from "./uno-rules";
import { signBudgetDelegation, signGameplayDelegation } from "./delegations";

export interface GameView {
  roomId: string;
  fee: string;
  seats: { address: Address; role: "human" | "bot"; paid: boolean; handCount: number }[];
  board: { topColor: number; topValue: number; activeColor: number };
  direction: 1 | -1;
  winner: Address | null;
  payoutTx: Hex | null;
  startedPlay: boolean;
  pot: Address;
  shuffleTx?: Hex;
  currentTurn?: Address | null;
}

export class UnoClient {
  constructor(
    private readonly baseUrl: string,
    private readonly account: LocalAccount,
  ) {}
  // baseUrl defaults to "" (same-origin) from the caller — the backend now lives
  // in this Next.js app under /api/*.

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

  state(): Promise<GameView & { ok: boolean }> {
    return this.get("/api/state");
  }

  /** Seat THIS wallet (seat 0) + the server bots and start a fresh game. */
  start(): Promise<{ ok: boolean; roomId?: string; error?: string }> {
    return this.post("/api/start", { human: this.account.address });
  }

  /** Reveal the caller's OWN sealed hand + the legal-play indices. */
  hand(): Promise<{ ok: boolean; hand: UnoCard[]; legal: number[]; handCount: number; error?: string }> {
    return this.post("/api/hand", { player: this.account.address });
  }

  /** Sign the budget delegation and pay the entry fee (real USDC → Pot). */
  async pay(pot: Address, fee: string): Promise<{ ok: boolean; txHash?: Hex; error?: string }> {
    const perActionCap = fee; // exactly the fee
    const totalCap = (Number(fee) * 2).toString();
    const signedBudget = await signBudgetDelegation(this.account, pot, perActionCap, totalCap);
    return this.post("/api/charge", { player: this.account.address, signedBudget });
  }

  /** Sign the gameplay delegation once and cache it for the room. */
  private gameplayByRoom = new Map<string, Awaited<ReturnType<typeof signGameplayDelegation>>>();
  private async gameplay(roomId: string) {
    let s = this.gameplayByRoom.get(roomId);
    if (!s) {
      s = await signGameplayDelegation(this.account, BigInt(roomId));
      this.gameplayByRoom.set(roomId, s);
    }
    return s;
  }

  /** Submit a gasless move (play/draw). For a wild, pass `chosenColor` (1..4). */
  async move(
    roomId: string,
    kind: "play" | "draw",
    card?: UnoCard,
    chosenColor?: number,
  ): Promise<{ ok: boolean; txHash?: Hex; winner?: Address | null; payoutTx?: Hex | null; playable?: boolean; error?: string }> {
    const signedGameplay = await this.gameplay(roomId);
    return this.post("/api/move", { player: this.account.address, signedGameplay, kind, card, chosenColor });
  }
}
