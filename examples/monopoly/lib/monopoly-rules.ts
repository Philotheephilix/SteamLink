/**
 * The AUTHORITATIVE, full-ruleset Monopoly engine (pure logic — no chain, no I/O).
 *
 * Implements the standard US edition: the full 40-space board, buying, rent (with
 * monopolies, houses/hotels, railroads scaling by count, utilities scaling by dice),
 * taxes, GO bonus, jail (pay / roll doubles / get-out card), doubles (3-in-a-row →
 * jail), Chance & Community Chest decks, building houses/hotels (own full group,
 * build evenly), mortgaging, and BANKRUPTCY — a player who cannot meet a debt even
 * after mortgaging everything is eliminated (assets transfer to the creditor, or
 * return to the bank if the debt was to the bank). WIN = the last solvent player.
 *
 * Money is plain in-game dollars; the server maps each settled transfer to a tiny
 * REAL USDC x402 charge (see lib/board DOLLAR_TO_USDC). This module decides WHAT
 * happens; the server settles the real money + records the action on-chain.
 *
 * Termination: real bankruptcy is the expected finish (small bankroll + full rent
 * tables make a player go bankrupt within a bounded number of rounds). A round cap
 * (ROUND_CAP) is a documented safety net only: if reached, the richest net-worth
 * solvent player wins.
 */
import {
  BOARD,
  BOARD_SIZE,
  GO_BONUS,
  GO_INDEX,
  GO_TO_JAIL_INDEX,
  GROUP_MEMBERS,
  JAIL_FINE,
  JAIL_INDEX,
  RAILROAD_RENT,
  type ColorGroup,
  type Space,
  isOwnable,
} from "./board";

// Bankroll tuned so a real game actually PLAYS OUT (property buys, rent payments, a
// few tax hits) over many rounds before someone bankrupts — instead of an instant
// turn-1 bankruptcy when a player lands on the $200 Income Tax. Big enough to survive
// early big tiles + buy several properties; small enough that accumulating rent +
// taxes still bankrupts a player within the round budget. Overridable via START_CASH.
export const START_CASH = Number(process.env.START_CASH ?? 300);
// Safety-net round cap (richest-player wins if no bankruptcy). Lowered so a slow game
// still finishes within the e2e budget; the expected finish is still a real bankruptcy.
// Overridable via ROUND_CAP.
export const ROUND_CAP = Number(process.env.ROUND_CAP ?? 20);

export interface PlayerState {
  id: string; // address (lowercased) — the on-chain identity
  name: string; // display ("You" / "Bot 1")
  role: "human" | "bot";
  cash: number;
  position: number;
  inJail: boolean;
  jailTurns: number; // consecutive turns spent trying to leave jail
  getOutCards: number;
  bankrupt: boolean;
}

export interface PropertyState {
  spaceId: number;
  owner: string | null; // player id or null (bank)
  houses: number; // 0..4; 5 = hotel
  mortgaged: boolean;
}

/** A discrete real-money settlement the engine asks the SERVER to perform on-chain. */
export interface Settlement {
  /** who pays (player id) */
  from: string;
  /** who receives: a player id, or "bank" (→ Pot, kept by the house/eventual winner) */
  to: string | "bank";
  /** in-game dollars */
  amount: number;
  reason: string;
}

/** The result of applying an action — the new pending step + any real settlements. */
export interface StepResult {
  settlements: Settlement[];
  log: string[];
  /** what the current player must do next before their turn can end */
  pending: Pending | null;
  /** dice (when the step was a roll) */
  dice?: [number, number];
}

export type Pending =
  | { kind: "buy"; spaceId: number; price: number }
  | { kind: "pay"; to: string | "bank"; amount: number; reason: string }
  | { kind: "end" }; // landing resolved, may build/mortgage then end turn

export interface GameSnapshot {
  roomId: string;
  players: PlayerState[];
  properties: Record<number, PropertyState>;
  order: string[]; // turn order (player ids)
  turnIndex: number; // index into order of the player whose turn it is
  round: number;
  doublesCount: number;
  pending: Pending | null;
  rolledThisTurn: boolean;
  winner: string | null;
  cardLog: string[];
}

// ── deck cards ────────────────────────────────────────────────────────────────

type CardEffect =
  | { type: "money"; amount: number } // +/- from bank
  | { type: "moveTo"; pos: number; collectGo?: boolean }
  | { type: "moveBy"; steps: number }
  | { type: "gotoJail" }
  | { type: "getOutCard" }
  | { type: "collectFromEach"; amount: number } // each other player pays you
  | { type: "payEach"; amount: number }; // you pay each other player

interface Card {
  text: string;
  effect: CardEffect;
}

/** Standard Chance deck (faithful subset of the official 16; see README for omissions). */
const CHANCE: Card[] = [
  { text: "Advance to GO (collect $200)", effect: { type: "moveTo", pos: 0, collectGo: true } },
  { text: "Advance to Illinois Ave", effect: { type: "moveTo", pos: 24, collectGo: true } },
  { text: "Advance to St. Charles Place", effect: { type: "moveTo", pos: 11, collectGo: true } },
  { text: "Advance to Boardwalk", effect: { type: "moveTo", pos: 39, collectGo: true } },
  { text: "Go directly to Jail", effect: { type: "gotoJail" } },
  { text: "Bank pays you dividend of $50", effect: { type: "money", amount: 50 } },
  { text: "Get Out of Jail Free", effect: { type: "getOutCard" } },
  { text: "Go back 3 spaces", effect: { type: "moveBy", steps: -3 } },
  { text: "Pay poor tax of $15", effect: { type: "money", amount: -15 } },
  { text: "Your building loan matures — collect $150", effect: { type: "money", amount: 150 } },
  { text: "Speeding fine $15", effect: { type: "money", amount: -15 } },
  { text: "You have been elected Chairman — pay each player $25", effect: { type: "payEach", amount: 25 } },
  { text: "Advance to Reading Railroad", effect: { type: "moveTo", pos: 5, collectGo: true } },
  { text: "Make general repairs — pay bank $40", effect: { type: "money", amount: -40 } },
  { text: "Crypto airdrop — collect $100", effect: { type: "money", amount: 100 } },
  { text: "Gas fees spike — pay bank $30", effect: { type: "money", amount: -30 } },
];

/** Standard Community Chest deck (faithful subset of the official 16). */
const CHEST: Card[] = [
  { text: "Advance to GO (collect $200)", effect: { type: "moveTo", pos: 0, collectGo: true } },
  { text: "Bank error in your favor — collect $200", effect: { type: "money", amount: 200 } },
  { text: "Doctor's fee — pay $50", effect: { type: "money", amount: -50 } },
  { text: "From sale of stock you get $50", effect: { type: "money", amount: 50 } },
  { text: "Get Out of Jail Free", effect: { type: "getOutCard" } },
  { text: "Go directly to Jail", effect: { type: "gotoJail" } },
  { text: "Grand Opera Night — collect $50 from every player", effect: { type: "collectFromEach", amount: 50 } },
  { text: "Holiday fund matures — collect $100", effect: { type: "money", amount: 100 } },
  { text: "Income tax refund — collect $20", effect: { type: "money", amount: 20 } },
  { text: "It's your birthday — collect $10 from each player", effect: { type: "collectFromEach", amount: 10 } },
  { text: "Life insurance matures — collect $100", effect: { type: "money", amount: 100 } },
  { text: "Hospital fees — pay $50", effect: { type: "money", amount: -50 } },
  { text: "School fees — pay $50", effect: { type: "money", amount: -50 } },
  { text: "Consultancy fee — collect $25", effect: { type: "money", amount: 25 } },
  { text: "You inherit $100", effect: { type: "money", amount: 100 } },
  { text: "Staking rewards — collect $75", effect: { type: "money", amount: 75 } },
];

// ── the engine ──────────────────────────────────────────────────────────────

export class MonopolyRules {
  readonly roomId: string;
  players: PlayerState[];
  properties: Record<number, PropertyState> = {};
  order: string[];
  turnIndex = 0;
  round = 1;
  doublesCount = 0;
  pending: Pending | null = null;
  rolledThisTurn = false;
  winner: string | null = null;
  cardLog: string[] = [];

  private chanceDeck: Card[];
  private chestDeck: Card[];
  private rng: () => number;

  constructor(
    roomId: string,
    seats: Array<{ id: string; name: string; role: "human" | "bot" }>,
    rng: () => number = Math.random,
  ) {
    this.roomId = roomId;
    this.rng = rng;
    this.players = seats.map((s) => ({
      id: s.id.toLowerCase(),
      name: s.name,
      role: s.role,
      cash: START_CASH,
      position: 0,
      inJail: false,
      jailTurns: 0,
      getOutCards: 0,
      bankrupt: false,
    }));
    this.order = this.players.map((p) => p.id);
    for (const s of BOARD) {
      if (isOwnable(s)) this.properties[s.id] = { spaceId: s.id, owner: null, houses: 0, mortgaged: false };
    }
    this.chanceDeck = this.shuffle(CHANCE);
    this.chestDeck = this.shuffle(CHEST);
  }

  // ── lookups ──
  player(id: string): PlayerState | undefined {
    return this.players.find((p) => p.id === id.toLowerCase());
  }
  current(): PlayerState {
    return this.player(this.order[this.turnIndex])!;
  }
  prop(spaceId: number): PropertyState | undefined {
    return this.properties[spaceId];
  }
  private space(pos: number): Space {
    return BOARD[((pos % BOARD_SIZE) + BOARD_SIZE) % BOARD_SIZE];
  }
  solvent(): PlayerState[] {
    return this.players.filter((p) => !p.bankrupt);
  }

  /** Net worth (cash + property value + house value + half-value of mortgaged). */
  netWorth(id: string): number {
    const p = this.player(id);
    if (!p) return 0;
    let w = p.cash;
    for (const pr of Object.values(this.properties)) {
      if (pr.owner !== p.id) continue;
      const sp = BOARD[pr.spaceId];
      w += pr.mortgaged ? (sp.mortgage ?? 0) : (sp.price ?? 0);
      if (pr.houses > 0) w += pr.houses * (sp.houseCost ?? 0);
    }
    return w;
  }

  ownedBy(id: string): number[] {
    return Object.values(this.properties)
      .filter((pr) => pr.owner === id.toLowerCase())
      .map((pr) => pr.spaceId);
  }

  // ── shuffle ──
  private shuffle<T>(arr: T[]): T[] {
    const a = [...arr];
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(this.rng() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  // ── monopoly / rent helpers ──
  ownsFullGroup(id: string, group: ColorGroup): boolean {
    const members = GROUP_MEMBERS[group] ?? [];
    return members.length > 0 && members.every((sp) => this.properties[sp]?.owner === id);
  }

  railroadsOwned(id: string): number {
    return BOARD.filter((s) => s.kind === "railroad" && this.properties[s.id]?.owner === id).length;
  }
  utilitiesOwned(id: string): number {
    return BOARD.filter((s) => s.kind === "utility" && this.properties[s.id]?.owner === id).length;
  }

  /** Rent owed for landing on `spaceId`, given the dice total (for utilities). */
  rentFor(spaceId: number, diceTotal: number): number {
    const sp = BOARD[spaceId];
    const pr = this.properties[spaceId];
    if (!pr || !pr.owner || pr.mortgaged) return 0;
    if (sp.kind === "railroad") {
      return RAILROAD_RENT[this.railroadsOwned(pr.owner)] ?? 0;
    }
    if (sp.kind === "utility") {
      const mult = this.utilitiesOwned(pr.owner) === 2 ? 10 : 4;
      return diceTotal * mult;
    }
    // color property
    const rent = sp.rent!;
    if (pr.houses > 0) return rent[pr.houses]; // 1..5 = 1H..hotel
    // unimproved: doubled if the owner has the full color group
    const base = rent[0];
    return sp.group && this.ownsFullGroup(pr.owner, sp.group) ? base * 2 : base;
  }

  // ── turn flow ─────────────────────────────────────────────────────────────

  /**
   * Roll the dice (provided by the on-chain RandomnessCoordinator — passed in so the
   * roll is the real on-chain value) and resolve the landing. Returns the settlements
   * the server must perform on-chain + the pending action (buy / pay / end).
   */
  roll(die1: number, die2: number): StepResult {
    const p = this.current();
    const out: StepResult = { settlements: [], log: [], pending: null, dice: [die1, die2] };
    const isDouble = die1 === die2;

    // ── jail handling ──
    if (p.inJail) {
      if (isDouble) {
        p.inJail = false;
        p.jailTurns = 0;
        out.log.push(`${p.name} rolled doubles and leaves jail`);
        // proceed to move with this roll, but doubles in jail do NOT grant another turn
        this.doublesCount = 0;
        this.move(p, die1 + die2, out);
        this.rolledThisTurn = true;
        return out;
      }
      p.jailTurns++;
      if (p.jailTurns >= 3) {
        // forced to pay the $50 fine then move
        p.inJail = false;
        p.jailTurns = 0;
        out.settlements.push({ from: p.id, to: "bank", amount: JAIL_FINE, reason: "jail fine (3rd turn)" });
        p.cash -= JAIL_FINE;
        out.log.push(`${p.name} pays $${JAIL_FINE} jail fine (3rd attempt) and moves`);
        this.move(p, die1 + die2, out);
        this.rolledThisTurn = true;
        return out;
      }
      out.log.push(`${p.name} stays in jail (attempt ${p.jailTurns}/3)`);
      this.rolledThisTurn = true;
      this.pending = { kind: "end" };
      out.pending = this.pending;
      return out;
    }

    // ── doubles → extra turn; 3 doubles → jail ──
    if (isDouble) {
      this.doublesCount++;
      if (this.doublesCount >= 3) {
        out.log.push(`${p.name} rolled 3 doubles → Go To Jail`);
        this.sendToJail(p, out);
        this.rolledThisTurn = true;
        this.pending = { kind: "end" };
        out.pending = this.pending;
        return out;
      }
    } else {
      this.doublesCount = 0;
    }

    this.move(p, die1 + die2, out);
    this.rolledThisTurn = true;
    return out;
  }

  private move(p: PlayerState, steps: number, out: StepResult): void {
    const from = p.position;
    const raw = from + steps;
    const passedGo = raw >= BOARD_SIZE;
    p.position = ((raw % BOARD_SIZE) + BOARD_SIZE) % BOARD_SIZE;
    if (passedGo && steps > 0) {
      p.cash += GO_BONUS;
      out.settlements.push({ from: "bank", to: p.id, amount: GO_BONUS, reason: "passed GO" });
      out.log.push(`${p.name} passed GO (+$${GO_BONUS})`);
    }
    this.resolveLanding(p, steps, out);
  }

  private resolveLanding(p: PlayerState, diceTotal: number, out: StepResult): void {
    const sp = this.space(p.position);
    out.log.push(`${p.name} landed on ${sp.name}`);

    switch (sp.kind) {
      case "go":
      case "jail":
      case "free":
        this.pending = { kind: "end" };
        break;
      case "gotojail":
        this.sendToJail(p, out);
        this.pending = { kind: "end" };
        break;
      case "tax": {
        out.settlements.push({ from: p.id, to: "bank", amount: sp.tax!, reason: sp.name });
        p.cash -= sp.tax!;
        out.log.push(`${p.name} pays $${sp.tax} ${sp.name}`);
        this.pending = this.maybeBankrupt(p, sp.tax!, "bank", out) ?? { kind: "end" };
        break;
      }
      case "chance":
        this.drawCard(p, "chance", out);
        break;
      case "chest":
        this.drawCard(p, "chest", out);
        break;
      case "property":
      case "railroad":
      case "utility": {
        const pr = this.properties[sp.id];
        if (!pr.owner) {
          this.pending = { kind: "buy", spaceId: sp.id, price: sp.price! };
        } else if (pr.owner === p.id || pr.mortgaged) {
          this.pending = { kind: "end" };
        } else {
          const rent = this.rentFor(sp.id, diceTotal);
          if (rent <= 0) {
            this.pending = { kind: "end" };
          } else {
            out.settlements.push({ from: p.id, to: pr.owner, amount: rent, reason: `rent on ${sp.name}` });
            p.cash -= rent;
            this.player(pr.owner)!.cash += rent;
            out.log.push(`${p.name} pays $${rent} rent to ${this.player(pr.owner)!.name}`);
            this.pending = this.maybeBankrupt(p, rent, pr.owner, out) ?? { kind: "end" };
          }
        }
        break;
      }
    }
    out.pending = this.pending;
  }

  private drawCard(p: PlayerState, deck: "chance" | "chest", out: StepResult): void {
    const d = deck === "chance" ? this.chanceDeck : this.chestDeck;
    const card = d.shift()!;
    d.push(card); // recycle to the bottom
    this.cardLog.unshift(`${deck === "chance" ? "Chance" : "Community Chest"}: ${card.text}`);
    out.log.push(`${p.name} drew: ${card.text}`);
    const e = card.effect;
    switch (e.type) {
      case "money": {
        if (e.amount >= 0) {
          p.cash += e.amount;
          out.settlements.push({ from: "bank", to: p.id, amount: e.amount, reason: card.text });
        } else {
          const debt = -e.amount;
          p.cash -= debt;
          out.settlements.push({ from: p.id, to: "bank", amount: debt, reason: card.text });
          this.pending = this.maybeBankrupt(p, debt, "bank", out);
          if (this.pending) {
            out.pending = this.pending;
            return;
          }
        }
        this.pending = { kind: "end" };
        break;
      }
      case "getOutCard":
        p.getOutCards++;
        this.pending = { kind: "end" };
        break;
      case "gotoJail":
        this.sendToJail(p, out);
        this.pending = { kind: "end" };
        break;
      case "moveTo": {
        const passed = e.pos < p.position && e.collectGo;
        p.position = e.pos;
        if (passed) {
          p.cash += GO_BONUS;
          out.settlements.push({ from: "bank", to: p.id, amount: GO_BONUS, reason: "passed GO (card)" });
        }
        this.resolveLanding(p, 0, out);
        return;
      }
      case "moveBy": {
        p.position = ((p.position + e.steps) % BOARD_SIZE + BOARD_SIZE) % BOARD_SIZE;
        this.resolveLanding(p, 0, out);
        return;
      }
      case "collectFromEach": {
        for (const other of this.solvent()) {
          if (other.id === p.id) continue;
          other.cash -= e.amount;
          p.cash += e.amount;
          out.settlements.push({ from: other.id, to: p.id, amount: e.amount, reason: card.text });
        }
        this.pending = { kind: "end" };
        break;
      }
      case "payEach": {
        for (const other of this.solvent()) {
          if (other.id === p.id) continue;
          p.cash -= e.amount;
          other.cash += e.amount;
          out.settlements.push({ from: p.id, to: other.id, amount: e.amount, reason: card.text });
        }
        this.pending = { kind: "end" };
        break;
      }
    }
    out.pending = this.pending;
  }

  private sendToJail(p: PlayerState, out: StepResult): void {
    p.position = JAIL_INDEX;
    p.inJail = true;
    p.jailTurns = 0;
    this.doublesCount = 0;
    out.log.push(`${p.name} goes to Jail`);
  }

  // ── actions resolving a pending step ────────────────────────────────────────

  /** Buy the property the current player is standing on. */
  buy(): StepResult {
    const p = this.current();
    const out: StepResult = { settlements: [], log: [], pending: null };
    if (this.pending?.kind !== "buy") throw new Error("no pending buy");
    const { spaceId, price } = this.pending;
    if (p.cash < price) throw new Error("cannot afford");
    p.cash -= price;
    this.properties[spaceId].owner = p.id;
    out.settlements.push({ from: p.id, to: "bank", amount: price, reason: `buy ${BOARD[spaceId].name}` });
    out.log.push(`${p.name} bought ${BOARD[spaceId].name} for $${price}`);
    this.pending = { kind: "end" };
    out.pending = this.pending;
    return out;
  }

  /** Decline to buy (no auction — documented simplification). */
  decline(): StepResult {
    if (this.pending?.kind !== "buy") throw new Error("no pending buy");
    this.pending = { kind: "end" };
    return { settlements: [], log: [`${this.current().name} declined to buy`], pending: this.pending };
  }

  /**
   * Build one house/hotel on a property the player owns (must own the full group, no
   * mortgaged member, build evenly). No on-chain money (house cost is a bank debit
   * settled as a real charge to the Pot/bank).
   */
  build(spaceId: number): StepResult {
    const p = this.current();
    const out: StepResult = { settlements: [], log: [], pending: this.pending };
    const sp = BOARD[spaceId];
    const pr = this.properties[spaceId];
    if (!pr || pr.owner !== p.id) throw new Error("not your property");
    if (sp.kind !== "property" || !sp.group) throw new Error("cannot build here");
    if (!this.ownsFullGroup(p.id, sp.group)) throw new Error("need full color group");
    if (pr.houses >= 5) throw new Error("already a hotel");
    // build evenly: no group member may be more than 1 house behind this one
    const members = GROUP_MEMBERS[sp.group];
    const minH = Math.min(...members.map((m) => this.properties[m].houses));
    if (pr.houses > minH) throw new Error("must build evenly");
    if (members.some((m) => this.properties[m].mortgaged)) throw new Error("group has a mortgaged lot");
    const cost = sp.houseCost!;
    if (p.cash < cost) throw new Error("cannot afford house");
    p.cash -= cost;
    pr.houses++;
    out.settlements.push({ from: p.id, to: "bank", amount: cost, reason: `build on ${sp.name}` });
    out.log.push(`${p.name} built a ${pr.houses === 5 ? "hotel" : "house"} on ${sp.name} ($${cost})`);
    return out;
  }

  /** Mortgage a property (collect 50% of price; no rent until unmortgaged). */
  mortgage(spaceId: number): StepResult {
    const p = this.current();
    const sp = BOARD[spaceId];
    const pr = this.properties[spaceId];
    if (!pr || pr.owner !== p.id) throw new Error("not your property");
    if (pr.mortgaged) throw new Error("already mortgaged");
    if (pr.houses > 0) throw new Error("sell houses first");
    pr.mortgaged = true;
    p.cash += sp.mortgage!;
    return {
      settlements: [{ from: "bank", to: p.id, amount: sp.mortgage!, reason: `mortgage ${sp.name}` }],
      log: [`${p.name} mortgaged ${sp.name} (+$${sp.mortgage})`],
      pending: this.pending,
    };
  }

  /** Unmortgage (pay mortgage + 10%). */
  unmortgage(spaceId: number): StepResult {
    const p = this.current();
    const sp = BOARD[spaceId];
    const pr = this.properties[spaceId];
    if (!pr || pr.owner !== p.id || !pr.mortgaged) throw new Error("not mortgaged");
    const cost = Math.round(sp.mortgage! * 1.1);
    if (p.cash < cost) throw new Error("cannot afford to unmortgage");
    pr.mortgaged = false;
    p.cash -= cost;
    return {
      settlements: [{ from: p.id, to: "bank", amount: cost, reason: `unmortgage ${sp.name}` }],
      log: [`${p.name} unmortgaged ${sp.name} (-$${cost})`],
      pending: this.pending,
    };
  }

  /** Pay the $50 fine to leave jail immediately (before rolling). */
  payJail(): StepResult {
    const p = this.current();
    if (!p.inJail) throw new Error("not in jail");
    if (p.getOutCards > 0) {
      p.getOutCards--;
      p.inJail = false;
      p.jailTurns = 0;
      return { settlements: [], log: [`${p.name} used a Get Out of Jail Free card`], pending: null };
    }
    if (p.cash < JAIL_FINE) throw new Error("cannot afford jail fine");
    p.cash -= JAIL_FINE;
    p.inJail = false;
    p.jailTurns = 0;
    return {
      settlements: [{ from: p.id, to: "bank", amount: JAIL_FINE, reason: "jail fine" }],
      log: [`${p.name} paid $${JAIL_FINE} to leave jail`],
      pending: null,
    };
  }

  // ── bankruptcy ──────────────────────────────────────────────────────────────

  /**
   * After a debit that may exceed cash, if the player is below zero, try to raise
   * cash by mortgaging assets (and selling houses). If still short, declare
   * bankruptcy: assets transfer to the creditor (a player) or back to the bank.
   * Returns null if the player is fine (or recovered) → caller proceeds to { end }.
   */
  private maybeBankrupt(p: PlayerState, _debt: number, creditor: string | "bank", out: StepResult): Pending | null {
    if (p.cash >= 0) return null;
    // auto-liquidate: sell houses then mortgage to cover the shortfall
    this.autoRaiseCash(p, out);
    if (p.cash >= 0) {
      out.log.push(`${p.name} raised cash to cover the debt`);
      return null;
    }
    // still insolvent → bankrupt
    this.declareBankrupt(p, creditor, out);
    return { kind: "end" };
  }

  /** Sell houses (half cost) then mortgage properties until cash ≥ 0 or nothing left. */
  private autoRaiseCash(p: PlayerState, out: StepResult): void {
    const mine = this.ownedBy(p.id);
    // 1) sell houses for half the build cost
    for (const sid of mine) {
      const pr = this.properties[sid];
      const sp = BOARD[sid];
      while (pr.houses > 0 && p.cash < 0) {
        pr.houses--;
        const refund = Math.round((sp.houseCost ?? 0) / 2);
        p.cash += refund;
        out.settlements.push({ from: "bank", to: p.id, amount: refund, reason: `sell house on ${sp.name}` });
        out.log.push(`${p.name} sold a house on ${sp.name} (+$${refund})`);
      }
    }
    // 2) mortgage unmortgaged properties
    for (const sid of mine) {
      if (p.cash >= 0) break;
      const pr = this.properties[sid];
      const sp = BOARD[sid];
      if (pr.mortgaged || pr.houses > 0) continue;
      pr.mortgaged = true;
      p.cash += sp.mortgage!;
      out.settlements.push({ from: "bank", to: p.id, amount: sp.mortgage!, reason: `mortgage ${sp.name}` });
      out.log.push(`${p.name} mortgaged ${sp.name} to raise cash (+$${sp.mortgage})`);
    }
  }

  private declareBankrupt(p: PlayerState, creditor: string | "bank", out: StepResult): void {
    p.bankrupt = true;
    out.log.push(`${p.name} is BANKRUPT (debt to ${creditor === "bank" ? "the bank" : this.player(creditor)?.name})`);
    // transfer assets
    for (const pr of Object.values(this.properties)) {
      if (pr.owner !== p.id) continue;
      if (creditor === "bank") {
        pr.owner = null;
        pr.houses = 0;
        pr.mortgaged = false;
      } else {
        pr.owner = creditor;
        // creditor inherits mortgaged status; houses are sold to the bank for the
        // bankrupt's benefit-of-doubt simplification → cleared
        pr.houses = 0;
      }
    }
    // remaining cash goes to the creditor (if a player)
    if (creditor !== "bank" && p.cash > 0) {
      const c = this.player(creditor);
      if (c) c.cash += p.cash;
    }
    p.cash = 0;
    this.checkWinner();
  }

  private checkWinner(): void {
    const alive = this.solvent();
    if (alive.length === 1) {
      this.winner = alive[0].id;
    }
  }

  // ── end of turn / advance ───────────────────────────────────────────────────

  /**
   * End the current player's turn. If they rolled doubles (and aren't in jail / didn't
   * get jailed) they go again; otherwise advance to the next solvent player. Returns
   * the id of the player whose turn it now is (or null if the game is over).
   */
  endTurn(): { nextPlayer: string | null; sameTurn: boolean } {
    if (this.winner) return { nextPlayer: null, sameTurn: false };
    const p = this.current();
    const goAgain = this.doublesCount > 0 && this.doublesCount < 3 && !p.inJail && !p.bankrupt;
    this.pending = null;
    this.rolledThisTurn = false;
    if (goAgain) {
      return { nextPlayer: p.id, sameTurn: true };
    }
    this.doublesCount = 0;
    // advance to the next non-bankrupt player
    const n = this.order.length;
    for (let i = 1; i <= n; i++) {
      const idx = (this.turnIndex + i) % n;
      const cand = this.player(this.order[idx])!;
      if (!cand.bankrupt) {
        if (idx <= this.turnIndex) this.round++; // wrapped → new round
        this.turnIndex = idx;
        // round-cap safety net
        if (this.round > ROUND_CAP && !this.winner) {
          this.endByRoundCap();
          return { nextPlayer: null, sameTurn: false };
        }
        return { nextPlayer: cand.id, sameTurn: false };
      }
    }
    return { nextPlayer: null, sameTurn: false };
  }

  /** Round-cap safety net: richest solvent player (net worth) wins. Documented. */
  private endByRoundCap(): void {
    const alive = this.solvent();
    let best = alive[0];
    for (const a of alive) if (this.netWorth(a.id) > this.netWorth(best.id)) best = a;
    this.winner = best.id;
    this.cardLog.unshift(`Round cap (${ROUND_CAP}) reached — richest player ${best.name} wins (safety net)`);
  }

  snapshot(): GameSnapshot {
    return {
      roomId: this.roomId,
      players: this.players.map((p) => ({ ...p })),
      properties: Object.fromEntries(Object.entries(this.properties).map(([k, v]) => [k, { ...v }])),
      order: [...this.order],
      turnIndex: this.turnIndex,
      round: this.round,
      doublesCount: this.doublesCount,
      pending: this.pending,
      rolledThisTurn: this.rolledThisTurn,
      winner: this.winner,
      cardLog: this.cardLog.slice(0, 20),
    };
  }
}
