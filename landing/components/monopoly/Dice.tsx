"use client";

const PIPS: Record<number, [number, number][]> = {
  1: [[1, 1]],
  2: [[0, 0], [2, 2]],
  3: [[0, 0], [1, 1], [2, 2]],
  4: [[0, 0], [0, 2], [2, 0], [2, 2]],
  5: [[0, 0], [0, 2], [1, 1], [2, 0], [2, 2]],
  6: [[0, 0], [0, 2], [1, 0], [1, 2], [2, 0], [2, 2]],
};

function Face({ n, rolling }: { n: number; rolling: boolean }) {
  return (
    <div
      data-testid="die"
      className={`bg-paper border-[2.5px] border-ink shadow-sticker-sm w-12 h-12 sm:w-14 sm:h-14 rounded-xl grid p-1.5 ${rolling ? "animate-rolldice" : ""}`}
      style={{ gridTemplateColumns: "repeat(3,1fr)", gridTemplateRows: "repeat(3,1fr)" }}
    >
      {Array.from({ length: 9 }).map((_, i) => {
        const r = Math.floor(i / 3);
        const c = i % 3;
        const on = (PIPS[n] || []).some(([pr, pc]) => pr === r && pc === c);
        return (
          <div key={i} className="flex items-center justify-center">
            {on && <div className="w-2 h-2 rounded-full bg-ink" />}
          </div>
        );
      })}
    </div>
  );
}

export function Dice({ die1, die2, rolling }: { die1: number; die2: number; rolling: boolean }) {
  return (
    <div className="flex items-center gap-3" data-testid="dice-tray">
      <Face n={die1 || 1} rolling={rolling} />
      <Face n={die2 || 1} rolling={rolling} />
      <div className="text-ink-faint text-sm font-mono">
        = <span className="text-grape text-lg font-extrabold font-display">{(die1 || 0) + (die2 || 0)}</span>
      </div>
    </div>
  );
}
