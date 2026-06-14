"use client";

import { BOARD, BOARD_SIZE, type Space } from "@/lib/monopoly/board";
import type { PlayerView, PropertyView } from "@/lib/monopoly/monopoly-client";

/**
 * The full 40-space Monopoly board as an 11x11 perimeter ring. Space 0 (GO) is the
 * bottom-right corner; the ring runs counter-clockwise (up the right edge, across the
 * top, down the left, back along the bottom) — the classic travel direction. Each
 * tile shows its color band, name, and price; owned tiles show the owner's token
 * color and a house/hotel count; player tokens sit on their current tile.
 */

const SIDE = 11; // 11x11 grid → 40 perimeter cells

/** grid (row,col) 1-indexed for spaceId 0..39 going counter-clockwise from GO. */
function ringCell(id: number): { r: number; c: number } {
  // 0 bottom-right corner; 1..9 up the right edge; 10 top-right corner;
  // 11..19 across the top (right→left); 20 top-left; 21..29 down the left;
  // 30 bottom-left; 31..39 across the bottom (left→right).
  if (id === 0) return { r: SIDE, c: SIDE };
  if (id < 10) return { r: SIDE - id, c: SIDE };
  if (id === 10) return { r: 1, c: SIDE };
  if (id < 20) return { r: 1, c: SIDE - (id - 10) };
  if (id === 20) return { r: 1, c: 1 };
  if (id < 30) return { r: 1 + (id - 20), c: 1 };
  if (id === 30) return { r: SIDE, c: 1 };
  return { r: SIDE, c: 1 + (id - 30) };
}

const TOKEN_COLORS = ["#22c55e", "#f59e0b", "#ef4444", "#8b5cf6", "#06b6d4", "#ec4899"];

/** Stable per-player token color (by seat order). Exported so the sidebar legend
 *  can show the same color next to each player's name. */
export function tokenColorFor(players: { address: string }[], address: string): string {
  const i = players.findIndex((p) => p.address.toLowerCase() === address.toLowerCase());
  return TOKEN_COLORS[(i < 0 ? 0 : i) % TOKEN_COLORS.length];
}

/**
 * A colored game pawn (chess-pawn silhouette). The fill is the player's identity
 * color; a white outline + drop shadow keep it legible on any tile. The current
 * player's own pawn (`me`) is larger, glows, and gently bobs.
 */
export function Pawn({
  color,
  me = false,
  size,
  testId,
}: {
  color: string;
  me?: boolean;
  size?: number;
  testId?: string;
}) {
  const h = size ?? (me ? 24 : 18);
  return (
    <span
      data-testid={testId}
      title={me ? "You" : "Opponent"}
      className={`pawn ${me ? "is-me" : ""}`}
      style={{ color, width: Math.round(h * 0.72), height: h }}
    >
      <svg viewBox="0 0 24 32" aria-hidden="true">
        <g fill="currentColor" stroke="#ffffff" strokeWidth={me ? 1.7 : 1.4} strokeLinejoin="round">
          <circle cx="12" cy="7" r="4.9" />
          <path d="M8 11 q4 2.7 8 0 l-1.9 5 q3.7 2.2 2.7 6.5 l1.7 3.5 H5.5 l1.7-3.5 q-1-4.3 2.7-6.5 z" />
        </g>
      </svg>
    </span>
  );
}

export function Board({
  players,
  properties,
  meAddress,
}: {
  players: PlayerView[];
  properties: Record<number, PropertyView>;
  meAddress: string | null;
}) {
  const colorOf = (addr: string): string => {
    const i = players.findIndex((p) => p.address.toLowerCase() === addr.toLowerCase());
    return TOKEN_COLORS[i % TOKEN_COLORS.length];
  };

  return (
    <div className="bg-paper-deep border-[2.5px] border-ink shadow-sticker-lg rounded-chunk p-2 sm:p-4">
      <div
        className="relative grid gap-[3px]"
        style={{ gridTemplateColumns: `repeat(${SIDE}, 1fr)`, gridTemplateRows: `repeat(${SIDE}, 1fr)`, aspectRatio: "1 / 1" }}
      >
        {/* center medallion */}
        <div className="flex flex-col items-center justify-center rounded-2xl bg-paper border-[2px] border-ink/20" style={{ gridColumn: "2 / 11", gridRow: "2 / 11" }}>
          <div className="text-center select-none">
            <div className="font-display text-3xl sm:text-5xl font-extrabold tracking-tight text-grape">NEXUS</div>
            <div className="text-ink-faint text-[10px] sm:text-xs tracking-[0.3em] mt-1 font-semibold uppercase">Onchain Monopoly</div>
            <div className="mt-3 text-[9px] sm:text-[10px] text-ink-faint uppercase tracking-widest">
              Base Sepolia · gasless dice · real USDC · full rules
            </div>
          </div>
        </div>

        {BOARD.map((sp) => {
          const cell = ringCell(sp.id);
          const pr = properties[sp.id];
          const owner = pr?.owner ?? null;
          const here = players.filter((p) => !p.bankrupt && p.position === sp.id);
          const isCorner = sp.kind === "go" || sp.kind === "jail" || sp.kind === "free" || sp.kind === "gotojail";
          return (
            <div
              key={sp.id}
              data-testid={`tile-${sp.id}`}
              className={`relative rounded-[5px] overflow-hidden flex flex-col border border-ink/20 ${owner ? "bg-amber/10" : "bg-paper"}`}
              style={{ gridColumn: cell.c, gridRow: cell.r }}
              title={sp.name}
            >
              {(sp.kind === "property") && <div className="h-1.5 w-full" style={{ background: sp.color }} />}
              <div className="flex-1 px-0.5 py-0.5 flex flex-col justify-between min-h-0">
                <div className={`leading-[1.05] font-semibold text-ink ${isCorner ? "text-[7px] sm:text-[8px]" : "text-[6px] sm:text-[7px]"}`}>
                  {sp.name}
                </div>
                {sp.price != null && <div className="font-mono text-[6px] text-ink-faint">${sp.price}</div>}
              </div>
              {owner && (
                <div className="absolute bottom-0 left-0 right-0 h-1" style={{ background: colorOf(owner) }} data-testid={`owned-${sp.id}`} />
              )}
              {pr && pr.houses > 0 && (
                <div className="absolute top-0 right-0 px-0.5 text-[6px] font-bold text-paper bg-grass rounded-bl">
                  {pr.houses === 5 ? "H" : pr.houses}
                </div>
              )}
              {pr?.mortgaged && (
                <div className="absolute top-0 left-0 px-0.5 text-[6px] font-bold text-paper bg-berry rounded-br">M</div>
              )}
              {here.length > 0 && (
                <div className="absolute inset-x-0 bottom-0 flex items-end justify-center gap-[1px] pb-[1px] pointer-events-none z-20">
                  {here.map((p) => {
                    const isMe = p.address.toLowerCase() === meAddress?.toLowerCase();
                    return (
                      <Pawn
                        key={p.address}
                        color={colorOf(p.address)}
                        me={isMe}
                        testId={isMe ? "player-token" : undefined}
                      />
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

export { BOARD_SIZE };
export type { Space };
