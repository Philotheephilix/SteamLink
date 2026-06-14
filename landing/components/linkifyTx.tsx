import type { ReactNode } from "react";

const TX_RE = /(0x[0-9a-fA-F]{64})/g;
const FULL_TX = /^0x[0-9a-fA-F]{64}$/;
const EXPLORER = "https://sepolia.basescan.org/tx/";

/**
 * Turn any 0x… transaction hash inside a free-text log line into a clickable
 * anchor that opens the Base Sepolia explorer in a new tab. Non-hash text is
 * returned verbatim. Presentational only — used by the game activity logs.
 *
 * `linkClass` lets each game pass its accent (coral for UNO, grape for Monopoly).
 */
export function linkifyTx(
  text: string,
  linkClass = "text-coral underline underline-offset-2 hover:opacity-80",
): ReactNode[] {
  return text.split(TX_RE).map((part, i) =>
    FULL_TX.test(part) ? (
      <a
        key={i}
        href={`${EXPLORER}${part}`}
        target="_blank"
        rel="noreferrer"
        className={`font-mono ${linkClass}`}
        title={part}
      >
        {part.slice(0, 10)}…{part.slice(-6)}
      </a>
    ) : (
      <span key={i}>{part}</span>
    ),
  );
}
