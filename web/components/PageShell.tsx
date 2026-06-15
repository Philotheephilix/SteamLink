"use client";

import Link from "next/link";
import { motion } from "framer-motion";
import { Logo } from "./Logo";
import type { Mode } from "@/lib/mode";

/** Segmented Gamer / Dev switch with a sliding sticker thumb. */
function ModeToggle({ mode, onSwitch }: { mode: Mode; onSwitch: (m: Mode) => void }) {
  return (
    <div className="relative flex rounded-full border-[2.5px] border-ink bg-paper p-1 shadow-sticker-sm">
      <motion.span
        layout
        transition={{ type: "spring", stiffness: 420, damping: 32 }}
        className={`absolute inset-y-1 w-[calc(50%-2px)] rounded-full ${mode === "gamer" ? "left-1 bg-coral" : "left-[calc(50%+1px)] bg-sky"}`}
        aria-hidden
      />
      {(["gamer", "developer"] as Mode[]).map((m) => (
        <button
          key={m}
          onClick={() => onSwitch(m)}
          className={`relative z-10 rounded-full px-3.5 py-1 text-sm font-bold transition-colors sm:px-4 ${
            mode === m ? "text-paper" : "text-ink-soft hover:text-ink"
          }`}
        >
          {m === "gamer" ? "Gamer" : "Dev"}
        </button>
      ))}
    </div>
  );
}

export function PageShell({
  mode,
  onSwitch,
  children,
}: {
  mode: Mode;
  onSwitch: (m: Mode) => void;
  children: React.ReactNode;
}) {
  const cta = mode === "gamer" ? { label: "Play", href: "#library" } : { label: "Get started", href: "#start" };
  return (
    <div className="overflow-x-clip">
      <header className="sticky top-0 z-50 border-b-[2.5px] border-ink bg-paper/85 backdrop-blur-md">
        <nav className="mx-auto flex max-w-6xl items-center justify-between gap-3 px-5 py-3 sm:px-8">
          <Link href="/" className="shrink-0">
            <Logo wordClassName="hidden sm:inline" />
          </Link>

          <ModeToggle mode={mode} onSwitch={onSwitch} />

          <div className="flex shrink-0 items-center gap-2">
            <Link
              href="/docs"
              className="hidden rounded-full border-[2.5px] border-ink bg-paper px-3.5 py-1.5 text-sm font-bold text-ink shadow-sticker-sm transition-transform hover:-translate-y-0.5 sm:inline-block"
            >
              Docs
            </Link>
            <a
              href={cta.href}
              className="sticker sticker-lift sticker-press rounded-full bg-ink px-4 py-2 text-sm font-bold text-paper"
            >
              {cta.label}
            </a>
          </div>
        </nav>
      </header>

      {children}

      <footer className="mt-12 border-t-[2.5px] border-ink bg-paper-deep">
        <div className="mx-auto flex max-w-6xl flex-col items-start justify-between gap-6 px-5 py-12 sm:flex-row sm:items-center sm:px-8">
          <Logo size={34} />
          <p className="text-sm font-medium text-ink-soft">Gasless onchain games, settled on Base.</p>
          <button onClick={() => onSwitch(mode === "gamer" ? "developer" : "gamer")} className="text-sm font-bold text-ink-soft underline decoration-ink/30 decoration-2 underline-offset-4 hover:text-ink hover:decoration-ink">
            {mode === "gamer" ? "I'm actually a developer" : "I'm actually here to play"}
          </button>
        </div>
      </footer>
    </div>
  );
}
