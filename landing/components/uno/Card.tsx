"use client";

import {
  SKIP,
  REVERSE,
  DRAW_TWO,
  WILD,
  WILD_DRAW_FOUR,
  type UnoCard,
} from "@/lib/uno/uno-rules";

export type { UnoCard };

const COLOR_HEX: Record<number, string> = {
  1: "#e4002b", // red
  2: "#3aa935", // green
  3: "#0073cf", // blue
  4: "#ffcc00", // yellow
};

const COLOR_NAME: Record<number, string> = { 0: "wild", 1: "red", 2: "green", 3: "blue", 4: "yellow" };

export function colorName(c: number): string {
  return COLOR_NAME[c] ?? "—";
}

const isWild = (c: UnoCard) => c.color === 0 || c.value === WILD || c.value === WILD_DRAW_FOUR;

/** The glyph shown in a card's corners (short) and its big center label. */
function glyphs(c: UnoCard): { corner: string; center: React.ReactNode; aria: string } {
  switch (c.value) {
    case SKIP:
      return { corner: "Ø", center: <span className="text-4xl">⦸</span>, aria: "skip" };
    case REVERSE:
      return { corner: "⇄", center: <span className="text-4xl">⇄</span>, aria: "reverse" };
    case DRAW_TWO:
      return { corner: "+2", center: <span className="text-4xl">+2</span>, aria: "draw two" };
    case WILD:
      return { corner: "W", center: <WildPips />, aria: "wild" };
    case WILD_DRAW_FOUR:
      return { corner: "+4", center: <WildPips four />, aria: "wild draw four" };
    default:
      return { corner: String(c.value), center: String(c.value), aria: String(c.value) };
  }
}

function WildPips({ four }: { four?: boolean }) {
  return (
    <span className="flex flex-col items-center leading-none">
      <span className="text-2xl">
        <span style={{ color: "#e4002b" }}>◆</span>
        <span style={{ color: "#3aa935" }}>◆</span>
        <span style={{ color: "#0073cf" }}>◆</span>
        <span style={{ color: "#ffcc00" }}>◆</span>
      </span>
      {four && <span className="mt-0.5 text-base font-black">+4</span>}
    </span>
  );
}

export function Card({
  card,
  onClick,
  disabled,
  small,
  testid,
}: {
  card: UnoCard;
  onClick?: () => void;
  disabled?: boolean;
  small?: boolean;
  testid?: string;
}) {
  const wild = isWild(card);
  const bg = wild ? "#1e1b4b" : COLOR_HEX[card.color] ?? "#3a3a3a";
  const dim = small ? "w-16 h-24 text-xl" : "w-24 h-36 text-4xl";
  const accent = card.color === 4 ? "#1a1a1a" : "#ffffff";
  const g = glyphs(card);

  return (
    <button
      type="button"
      data-testid={testid}
      onClick={onClick}
      disabled={disabled}
      className={`card-face relative ${dim} rounded-2xl border-[2.5px] border-ink shadow-sticker select-none transition-transform ${
        disabled ? "opacity-40 cursor-not-allowed" : "cursor-pointer hover:-translate-y-3"
      }`}
      style={{ background: bg, color: accent }}
      aria-label={`${colorName(card.color)} ${g.aria}`}
    >
      <span className="absolute top-1.5 left-2 text-xs font-bold font-display opacity-95">{g.corner}</span>
      <span
        className="absolute inset-0 flex items-center justify-center font-extrabold font-display"
        style={{ textShadow: wild ? "0 0 12px rgba(255,255,255,0.4)" : "0 2px 0 rgba(0,0,0,0.22)" }}
      >
        {g.center}
      </span>
      <span className="absolute bottom-1.5 right-2 text-xs font-bold font-display rotate-180 opacity-95">{g.corner}</span>
      <span className="absolute inset-x-2 top-2 h-1/3 rounded-full bg-white/20 blur-md pointer-events-none" />
    </button>
  );
}
