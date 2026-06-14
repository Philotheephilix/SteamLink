/**
 * Next.js instrumentation hook. Runs ONCE per server process at RUNTIME (next dev /
 * next start), never during `next build`. We gate on the Node runtime so the
 * relayer-backed auto-start never loads in the Edge runtime or at build time.
 *
 * This is what makes `pnpm dev` (and `next start`) boot the whole game — the separate
 * `pnpm server` / `pnpm bots` processes are no longer required.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { startAutoGame } = await import("./lib/auto-start");
    await startAutoGame();
  }
}
