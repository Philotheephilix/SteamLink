/**
 * Playwright globalSetup.
 *
 * The game backend + bots now run INSIDE the Next.js app (instrumentation.ts →
 * lib/auto-start.ts), booted by playwright.config's `next dev` webServer. So this
 * setup no longer spawns a separate server/bots process — it only ensures the
 * player keys exist and are funded BEFORE the app boots (globalSetup runs before
 * the webServer starts), so:
 *   - players.local.json exists with stable keys (the test injects the human
 *     seat-0 key into the browser's localStorage guest wallet), and
 *   - auto-start reuses those funded keys instead of regenerating under load.
 *
 * The wait for a seated game happens in the spec's beforeAll (after the webServer
 * is up), since the game is created by the app itself.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..");
const PLAYERS = join(ROOT, "players.local.json");

export default async function globalSetup() {
  const tsx = join(ROOT, "node_modules", ".bin", "tsx");

  // Fund / top-up players (idempotent) BEFORE the app boots, so auto-start reuses
  // the same funded seat-0 human key the browser is injected with.
  console.log(existsSync(PLAYERS) ? "[e2e-setup] topping up existing players…" : "[e2e-setup] funding new players…");
  await new Promise<void>((resolve, reject) => {
    const f = spawn(tsx, ["scripts/fund-players.ts"], { cwd: ROOT, stdio: "inherit", env: process.env });
    f.on("error", reject);
    f.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`fund-players exited ${code}`))));
  });
  console.log("[e2e-setup] players funded. The app will auto-start the game + bots.");
}
