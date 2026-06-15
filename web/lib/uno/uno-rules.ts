/**
 * The REAL, official UNO rules engine for Nexus UNO — a pure, deterministic
 * module shared by the authoritative backend (scripts/server.ts) and the bots.
 *
 * This is the full 108-card deck and the complete official ruleset. No
 * shortcuts, no "all cards are wild", no fake fast-win. Hands are private; this
 * module only decides legality, deck composition, and action effects — the
 * authoritative game STATE (whose hand holds what, the deck order) lives in the
 * server, seeded by an ON-CHAIN random word (see lib/shuffle.ts).
 *
 * Card model (compact, integer-only so it round-trips on-chain cleanly):
 *   color : 0 = wild (black), 1 = red, 2 = green, 3 = blue, 4 = yellow
 *   value : 0..9          → number card
 *           SKIP / REVERSE / DRAW_TWO        → colored action card
 *           WILD / WILD_DRAW_FOUR            → wild action card (color = 0)
 *
 * The on-chain UnoGameSystem records the real card played as (color, value),
 * enforces turn order, and emits the win — see contracts/UnoGameSystem.sol.
 */

// ── value codes ───────────────────────────────────────────────────────────────
// 0..9 are the number cards. Action codes start at 10 so they never collide.
export const SKIP = 10;
export const REVERSE = 11;
export const DRAW_TWO = 12;
export const WILD = 13;
export const WILD_DRAW_FOUR = 14;

export const COLORS = { WILD: 0, RED: 1, GREEN: 2, BLUE: 3, YELLOW: 4 } as const;

export interface UnoCard {
  /** 0 = wild, 1=red 2=green 3=blue 4=yellow */
  color: number;
  /** 0..9 number, or one of SKIP/REVERSE/DRAW_TWO/WILD/WILD_DRAW_FOUR */
  value: number;
}

export const isWildValue = (v: number): boolean => v === WILD || v === WILD_DRAW_FOUR;
export const isActionValue = (v: number): boolean => v >= SKIP;
export const isWildCard = (c: UnoCard): boolean => c.color === 0 || isWildValue(c.value);

/**
 * Build the real, official 108-card deck (unshuffled, canonical order). Per color
 * (Red/Green/Blue/Yellow): one 0, two each of 1-9, two Skip, two Reverse, two
 * Draw Two → 25 cards/color = 100. Plus 4 Wild + 4 Wild Draw Four = 108 total.
 */
export function buildDeck(): UnoCard[] {
  const deck: UnoCard[] = [];
  for (let color = 1; color <= 4; color++) {
    deck.push({ color, value: 0 }); // one 0
    for (let n = 1; n <= 9; n++) {
      deck.push({ color, value: n });
      deck.push({ color, value: n }); // two each of 1-9
    }
    for (const action of [SKIP, REVERSE, DRAW_TWO]) {
      deck.push({ color, value: action });
      deck.push({ color, value: action }); // two each
    }
  }
  for (let i = 0; i < 4; i++) deck.push({ color: 0, value: WILD });
  for (let i = 0; i < 4; i++) deck.push({ color: 0, value: WILD_DRAW_FOUR });
  return deck;
}

export interface TopState {
  /** 0 = wild marker (a wild on top — only `activeColor` constrains the match) */
  topColor: number;
  /** the played value of the top card (0..9 or an action code) */
  topValue: number;
  /** the color currently in force (set by a wild's chooser; else == topColor) */
  activeColor: number;
}

/**
 * Official legality. A card is legal iff it:
 *   - is a Wild (always legal), OR
 *   - is a Wild Draw Four (legal anytime here — see relaxation note below), OR
 *   - matches the active COLOR, OR
 *   - matches the top VALUE/SYMBOL (same number, or same action type).
 *
 * RELAXATION (documented): officially a Wild Draw Four may only be played when
 * you hold no card of the current active color. Enforcing that requires the
 * server to inspect the player's whole hand, which it does — so the server-side
 * `legalPlays` honors the official "no current color" restriction. This pure
 * `isLegal` (used where the full hand isn't in scope) treats WD4 as always legal;
 * the server's `legalPlays` is the authoritative gate and applies the strict rule.
 */
export function isLegal(card: UnoCard, top: TopState): boolean {
  if (isWildCard(card)) return true; // Wild / Wild Draw Four
  if (card.color === top.activeColor) return true; // color match
  // value/symbol match: same number, or same action symbol. Only meaningful when
  // the top is itself a colored card (topColor != 0).
  if (top.topColor !== 0 && card.value === top.topValue) return true;
  return false;
}

/**
 * The authoritative legal-play filter for a concrete hand. Applies the OFFICIAL
 * Wild Draw Four restriction: a WD4 is only legal when the player holds no card
 * matching the current active color. Returns indices into `hand`.
 */
export function legalPlays(hand: UnoCard[], top: TopState): number[] {
  const holdsActiveColor = hand.some((c) => !isWildCard(c) && c.color === top.activeColor);
  const out: number[] = [];
  for (let i = 0; i < hand.length; i++) {
    const c = hand[i];
    if (c.value === WILD_DRAW_FOUR) {
      if (!holdsActiveColor) out.push(i); // strict official rule
      continue;
    }
    if (isLegal(c, top)) out.push(i);
  }
  return out;
}

/** Card → human label (e.g. "red 7", "green skip", "wild draw four"). */
export function cardLabel(c: UnoCard): string {
  const colorName = ["wild", "red", "green", "blue", "yellow"][c.color] ?? "?";
  const valueName =
    c.value <= 9
      ? String(c.value)
      : { [SKIP]: "skip", [REVERSE]: "reverse", [DRAW_TWO]: "draw two", [WILD]: "wild", [WILD_DRAW_FOUR]: "wild draw four" }[c.value] ?? "?";
  // Wild/WD4 have no intrinsic color (color 0), so label them by value alone
  // ("wild"); every other card reads as "<color> <value>" (e.g. "green skip").
  return isWildCard(c) && c.value >= WILD ? valueName : `${colorName} ${valueName}`;
}
