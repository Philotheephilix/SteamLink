/**
 * The authoritative, full-rules UNO game state machine (server-side). Holds the
 * deck, every player's hand, the discard pile, direction, active color, and the
 * turn cursor. Validates EVERY play against the official rules and applies action
 * effects (Skip / Reverse / Draw Two / Wild / Wild Draw Four), reshuffles the
 * discard into the draw pile when empty, and detects the real win (a player
 * legally playing their last card).
 *
 * This module is deck/turn logic only — it knows nothing about the chain. The
 * server (scripts/server.ts) seeds the deck order from an ON-CHAIN random word,
 * seals each hand with @steamlink/secrets, mirrors each legal move on-chain through
 * the player's gameplay delegation, and settles the pot on the real win.
 */
import {
  type UnoCard,
  type TopState,
  buildDeck,
  isWildCard,
  legalPlays,
  DRAW_TWO,
  REVERSE,
  SKIP,
  WILD_DRAW_FOUR,
} from "./uno-rules";
import { shuffleWithWord } from "./shuffle";

export const HAND_SIZE = 7; // official deal

export type Address = `0x${string}`;

export interface PlayedEffect {
  /** number of players skipped (Skip / Draw Two / Wild Draw Four → 1; else 0) */
  skipped: number;
  /** cards the NEXT player was forced to draw (Draw Two → 2, WD4 → 4, else 0) */
  forcedDraw: number;
  /** true if direction reversed */
  reversed: boolean;
  /** the player forced to draw (if any) and the cards they drew */
  forcedDrawTarget?: Address;
}

export class UnoGame {
  readonly seats: Address[];
  /** seat address → hand (ordered; private) */
  readonly hands: Map<Address, UnoCard[]> = new Map();
  deck: UnoCard[] = [];
  discard: UnoCard[] = [];
  /** +1 = clockwise (down the seats array), -1 = counter-clockwise */
  direction: 1 | -1 = 1;
  /** index into seats of the player whose turn it is */
  turnIndex = 0;
  activeColor = 1;
  winner?: Address;
  /** seats that currently have exactly one card (UNO state; penalty not enforced) */
  unoCalled: Set<Address> = new Set();

  constructor(seats: Address[]) {
    if (seats.length < 2) throw new Error("UNO needs ≥2 players");
    this.seats = seats.map((s) => s.toLowerCase() as Address);
  }

  /**
   * Deal from a deck whose order was fixed by the ON-CHAIN random word. Flips one
   * card to start the discard pile. Start-card rule (documented choice): if the
   * flipped start card is a Wild Draw Four we re-flip; if it is any other action
   * card we ALSO re-flip until a plain number card starts the pile (the simplest
   * unambiguous start). This keeps the opening deterministic from the seed.
   */
  deal(onChainWord: bigint): void {
    const ordered = shuffleWithWord(buildDeck(), onChainWord);
    // Deal HAND_SIZE to each seat, round-robin.
    let p = 0;
    for (const seat of this.seats) this.hands.set(seat, []);
    for (let n = 0; n < HAND_SIZE; n++) {
      for (const seat of this.seats) this.hands.get(seat)!.push(ordered[p++]);
    }
    // Flip the start card: skip any action card (and WD4) so the pile starts on a number.
    let start = ordered[p++];
    while (isWildCard(start) || start.value > 9) start = ordered[p++];
    this.discard = [start];
    this.activeColor = start.color;
    this.deck = ordered.slice(p);
    this.turnIndex = 0;
    this.direction = 1;
  }

  get top(): UnoCard {
    return this.discard[this.discard.length - 1];
  }

  topState(): TopState {
    const t = this.top;
    return {
      topColor: isWildCard(t) ? 0 : t.color,
      topValue: t.value,
      activeColor: this.activeColor,
    };
  }

  currentPlayer(): Address {
    return this.seats[this.turnIndex];
  }

  handOf(seat: Address): UnoCard[] {
    return this.hands.get(seat.toLowerCase() as Address) ?? [];
  }

  handCount(seat: Address): number {
    return this.handOf(seat).length;
  }

  private nextIndex(from: number, step = 1): number {
    const n = this.seats.length;
    // Double-mod keeps the index in [0, n) even when direction is -1 and the raw
    // sum goes negative (JS `%` returns a negative remainder for negative operands).
    return (((from + this.direction * step) % n) + n) % n;
  }

  /** Refill the draw pile from the discard (keeping the top), reshuffled. */
  private refillDeck(): void {
    if (this.deck.length > 0) return;
    const top = this.discard.pop()!;
    const rest = this.discard;
    this.discard = [top];
    // Reshuffle the recycled pile with a fresh seed derived from current state.
    const seed = BigInt(rest.length) * 0x9e3779b97f4a7c15n + BigInt(Date.now());
    this.deck = shuffleWithWord(rest, seed);
  }

  /** Draw one card for `seat` (refilling the deck if needed). Returns the card. */
  drawOne(seat: Address): UnoCard {
    this.refillDeck();
    const card = this.deck.pop();
    if (!card) throw new Error("draw pile exhausted");
    this.handOf(seat).push(card);
    return card;
  }

  /**
   * Validate a play WITHOUT mutating state. Throws a typed Error on an illegal
   * move (wrong turn, card not in hand, not a legal match). Returns the hand index
   * of the card to play. Use this to gate the on-chain recording BEFORE committing
   * the in-memory mutation, so a failed on-chain tx never desyncs the engine.
   */
  validatePlay(seat: Address, card: UnoCard): number {
    const me = seat.toLowerCase() as Address;
    if (this.winner) throw new Error("game already won");
    if (this.currentPlayer() !== me) throw new Error("NOT_YOUR_TURN");
    const hand = this.handOf(me);
    const idx = hand.findIndex((c) => c.color === card.color && c.value === card.value);
    if (idx === -1) throw new Error("CARD_NOT_IN_HAND");
    const legal = legalPlays(hand, this.topState());
    if (!legal.includes(idx)) throw new Error("ILLEGAL_MOVE");
    if (isWildCard(card)) {
      // A wild requires a valid chosen color (validated again at commit time).
    }
    return idx;
  }

  /**
   * Commit a validated play by the current player: remove the card, apply the
   * action effect, advance the turn, detect the win. `chosenColor` (1..4) is
   * required for wild cards. Call {@link validatePlay} first.
   */
  play(seat: Address, card: UnoCard, chosenColor?: number): PlayedEffect {
    const me = seat.toLowerCase() as Address;
    // Re-validate at commit time: validatePlay is pure, so re-running it here makes
    // play() safe to call directly and re-derives the authoritative hand index.
    const idx = this.validatePlay(seat, card);
    const hand = this.handOf(me);
    const played = hand.splice(idx, 1)[0];
    this.discard.push(played);

    // Set active color: a wild uses the chooser; else the card's own color.
    if (isWildCard(played)) {
      const cc = chosenColor ?? 1;
      if (cc < 1 || cc > 4) throw new Error("BAD_COLOR");
      this.activeColor = cc;
    } else {
      this.activeColor = played.color;
    }

    // UNO state.
    if (hand.length === 1) this.unoCalled.add(me);
    else this.unoCalled.delete(me);

    // Win: emptied the hand by a legal play.
    if (hand.length === 0) {
      this.winner = me;
      return { skipped: 0, forcedDraw: 0, reversed: false };
    }

    return this.applyEffect(played);
  }

  /** Apply an action card's turn/draw/direction effect and advance the turn. */
  private applyEffect(played: UnoCard): PlayedEffect {
    let reversed = false;
    let skipped = 0;
    let forcedDraw = 0;
    let forcedDrawTarget: Address | undefined;

    const advance = (step: number) => {
      this.turnIndex = this.nextIndex(this.turnIndex, step);
    };

    switch (played.value) {
      case REVERSE: {
        reversed = true;
        if (this.seats.length === 2) {
          // 2-player: Reverse acts as Skip (same player goes again → opponent skipped).
          this.direction = (this.direction * -1) as 1 | -1;
          advance(2);
          skipped = 1;
        } else {
          this.direction = (this.direction * -1) as 1 | -1;
          advance(1);
        }
        break;
      }
      case SKIP: {
        advance(2);
        skipped = 1;
        break;
      }
      case DRAW_TWO: {
        forcedDrawTarget = this.seats[this.nextIndex(this.turnIndex, 1)];
        for (let k = 0; k < 2; k++) this.drawOne(forcedDrawTarget);
        forcedDraw = 2;
        advance(2); // target draws AND is skipped
        skipped = 1;
        break;
      }
      case WILD_DRAW_FOUR: {
        forcedDrawTarget = this.seats[this.nextIndex(this.turnIndex, 1)];
        for (let k = 0; k < 4; k++) this.drawOne(forcedDrawTarget);
        forcedDraw = 4;
        advance(2);
        skipped = 1;
        break;
      }
      default: {
        // number card or plain Wild → just pass.
        advance(1);
      }
    }
    return { skipped, forcedDraw, reversed, forcedDrawTarget };
  }

  /**
   * The current player draws one card. If it is immediately playable they MAY
   * play it (caller decides); here we only draw and, if the drawn card is not
   * playable, pass the turn. Returns the drawn card and whether it is playable.
   */
  draw(seat: Address): { card: UnoCard; playable: boolean } {
    const me = seat.toLowerCase() as Address;
    if (this.winner) throw new Error("game already won");
    if (this.currentPlayer() !== me) throw new Error("NOT_YOUR_TURN");
    const card = this.drawOne(me);
    const playable = legalPlays([card], this.topState()).length > 0;
    if (!playable) {
      // No legal play from the draw → turn passes.
      this.turnIndex = this.nextIndex(this.turnIndex, 1);
    }
    if (this.handCount(me) !== 1) this.unoCalled.delete(me);
    return { card, playable };
  }

  /** Pass the turn explicitly (after a draw the player declines to play). */
  pass(seat: Address): void {
    const me = seat.toLowerCase() as Address;
    if (this.currentPlayer() !== me) throw new Error("NOT_YOUR_TURN");
    this.turnIndex = this.nextIndex(this.turnIndex, 1);
  }
}
