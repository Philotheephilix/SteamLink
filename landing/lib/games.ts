/**
 * Games library registry — the portable shell.
 *
 * Single source of truth for the catalog shown on the site. Today every entry
 * is a placeholder. When a real game is ported into the website's in-built
 * library, fill in `play`/`embedUrl` and flip `status` to "live":
 *
 *   - `status: "live"` → the card routes to `/play/<slug>` and the route mounts
 *                        the embedded game instead of the placeholder surface.
 *   - `embedUrl`       → optional: while a game still lives as a standalone app
 *                        (the Next.js demos), point here to iframe/redirect to it
 *                        until it's ported in-tree.
 *
 * Catalog-as-data means porting a game is a registry edit, not a page rewrite.
 */

export type GameStatus = "live" | "demo" | "coming-soon";

/** Each game owns a color world from the candy palette. */
export type GameAccent = "coral" | "grape" | "sky" | "grass" | "amber" | "berry";

export interface GameEntry {
  /** URL-safe id; drives the /play/<slug> route. */
  slug: string;
  title: string;
  /** Two-letter monogram for the sticker tile. */
  monogram: string;
  /** One-line hook shown on the card. */
  tagline: string;
  /** Longer description for the game's own page. */
  description: string;
  status: GameStatus;
  /** Players supported, e.g. "2–4". */
  players: string;
  /** Short mechanics surfaced as chips. */
  tags: string[];
  accent: GameAccent;
  /** Optional external URL while the game is still a standalone demo. */
  embedUrl?: string;
}

export const GAMES: GameEntry[] = [
  {
    slug: "uno",
    title: "UNO",
    monogram: "UN",
    tagline: "The full 108-card deck, dealt onchain.",
    description:
      "The official UNO ruleset, settled on Base. The shuffle is seeded by real onchain randomness, hands stay sealed until they're yours, and the 1 USDC entry is a real x402 payment. Empty your hand, win the pot.",
    status: "live",
    players: "2–4",
    tags: ["Cards", "Sealed hands", "x402 entry"],
    accent: "coral",
  },
  {
    slug: "monopoly",
    title: "Monopoly",
    monogram: "MO",
    tagline: "Full US ruleset, played to a real bankruptcy.",
    description:
      "The complete standard Monopoly board on Base. Every debit, buy, rent, tax, house, fine, is a real USDC charge bounded onchain by your spend caps. The last player solvent takes the pot. No fake win.",
    status: "live",
    players: "2–4",
    tags: ["Board", "Real USDC", "Spend caps"],
    accent: "grape",
  },
  {
    slug: "your-game",
    title: "Your game here",
    monogram: "+",
    tagline: "Define it as data, ship it gasless.",
    description:
      "Describe a game as tables and Solidity logic, deploy to Base with one command, and it lands in the library, gasless from the first move. The shelf is open.",
    status: "coming-soon",
    players: "—",
    tags: ["SDK", "Base", "Open"],
    accent: "sky",
  },
];

export function getGame(slug: string): GameEntry | undefined {
  return GAMES.find((g) => g.slug === slug);
}
