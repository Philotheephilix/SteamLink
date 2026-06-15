import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Docs — Steamlink",
  description:
    "Steamlink developer documentation: the @steamlink/* SDK reference (defineGame, the single delegation, gasless moves, x402 charges, secrets, randomness) and a step-by-step guide to contributing a new game by raising a PR.",
};

export default function DocsLayout({ children }: { children: React.ReactNode }) {
  return children;
}
