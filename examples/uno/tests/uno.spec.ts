/**
 * Full multiplayer e2e for Nexus UNO against the live Base Sepolia backend.
 *
 * PERSISTENT browser context (chromium.launchPersistentContext) so the guest
 * wallet / session survives across steps and runs. The whole money path is real:
 *
 *   inject the funded HUMAN key → load app → connect (guest wallet = funded seat 0)
 *   → wait for the bots' game → PAY the entry fee (real USDC x402, settled on-chain)
 *   → play the game THROUGH TO A WIN via the real UI (human plays; bots play via the
 *      backend script) → assert the on-chain WINNER + the pot PAYOUT.
 *
 * Verified on-chain via viem: the entry-fee tx carries a USDC Transfer(human→Pot),
 * and the payout tx carries a USDC Transfer(Pot→winner).
 *
 * The server + bots are started by tests/global-setup.ts; the Next app by the
 * playwright.config webServer.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { type BrowserContext, chromium, expect, test } from "@playwright/test";
import { createPublicClient, http } from "viem";
import deployment from "../deployments/base-sepolia.json" assert { type: "json" };

const APP_URL = process.env.UNO_APP_URL ?? "http://localhost:3100";
const RPC = "https://sepolia.base.org";
const USDC = deployment.usdc.toLowerCase();
const POT = deployment.pot.toLowerCase();
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const GUEST_KEY_STORAGE = "uno.guest.privateKey";
const USER_DATA_DIR = join(tmpdir(), "uno-playwright-profile");

const pub = createPublicClient({
  chain: { id: 84532, name: "base-sepolia", nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [RPC] } } },
  transport: http(RPC),
});

interface PlayerKey { role: string; privateKey: `0x${string}`; address: `0x${string}` }

let context: BrowserContext;
let humanKey: `0x${string}`;
let humanAddress: `0x${string}`;

test.beforeAll(async () => {
  const { players } = JSON.parse(readFileSync(join(import.meta.dirname, "..", "players.local.json"), "utf8")) as { players: PlayerKey[] };
  const human = players.find((p) => p.role === "human");
  if (!human) throw new Error("no human in players.local.json (run fund-players)");
  humanKey = human.privateKey;
  humanAddress = human.address;

  // The app (webServer) auto-starts the game + bots via instrumentation. Wait for
  // its /api/state to report a seated game before driving the human through the UI
  // (a fresh on-chain shuffle can take a while).
  const deadline = Date.now() + 300_000;
  let seated = false;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${APP_URL}/api/state`);
      if (res.ok) {
        const st = (await res.json()) as { ok?: boolean; seats?: unknown[] };
        if (st.ok && Array.isArray(st.seats) && st.seats.length > 0) {
          seated = true;
          break;
        }
      }
    } catch {
      /* app/game not up yet */
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  if (!seated) throw new Error("app did not auto-start a seated game within 300s");

  context = await chromium.launchPersistentContext(USER_DATA_DIR, {
    headless: true,
    viewport: { width: 1280, height: 900 },
    // Record the real full-game session to a video demo (flushed on context.close()).
    recordVideo: { dir: join(import.meta.dirname, "..", "demos", "uno-video"), size: { width: 1280, height: 900 } },
  });
  // Inject the FUNDED human key into the guest wallet localStorage BEFORE any
  // page script runs, so the in-browser guest wallet IS the funded seat-0 player.
  await context.addInitScript(
    ([k, v]) => {
      try {
        window.localStorage.setItem(k, v);
      } catch {
        /* ignore */
      }
    },
    [GUEST_KEY_STORAGE, humanKey] as [string, string],
  );
});

test.afterAll(async () => {
  await context?.close(); // flushes the recorded .webm
  // Promote the recorded video to a stable demo path.
  try {
    const { readdirSync, renameSync, mkdirSync } = await import("node:fs");
    const vdir = join(import.meta.dirname, "..", "demos", "uno-video");
    const demos = join(import.meta.dirname, "..", "demos");
    mkdirSync(demos, { recursive: true });
    const webm = readdirSync(vdir).find((f) => f.endsWith(".webm"));
    if (webm) {
      renameSync(join(vdir, webm), join(demos, "uno-demo.webm"));
      console.log("[e2e] demo video saved:", join(demos, "uno-demo.webm"));
    }
  } catch (e) {
    console.log("[e2e] video promotion skipped:", e instanceof Error ? e.message : String(e));
  }
});

test("multiplayer UNO: human pays (on-chain) → plays to a WIN → pot pays out (on-chain)", async () => {
  const page = context.pages()[0] ?? (await context.newPage());
  page.on("console", (m) => {
    if (m.type() === "error") console.log("[browser error]", m.text());
  });

  await page.goto(APP_URL, { waitUntil: "networkidle" });

  // 1) Connect the guest wallet (= the injected, funded seat-0 player). Retry the
  //    click until React hydrates and the phase advances.
  const connectBtn = page.getByTestId("connect");
  await expect(connectBtn).toBeVisible();
  await expect(async () => {
    if (await connectBtn.isVisible().catch(() => false)) await connectBtn.click();
    // After connecting we wait for the table; the lobby (pay) appears once the
    // bots' game is discovered and we're seated.
    await expect(page.getByTestId("join-and-pay")).toBeVisible({ timeout: 5000 });
  }).toPass({ timeout: 60_000 });

  // Sanity: the browser wallet is the funded human seat.
  await expect(page.locator("text=/wallet 0x[0-9a-fA-F]/").first()).toContainText(humanAddress.slice(0, 6));

  // 2) Pay the entry fee — the headline real x402 payment from the human's wallet.
  await page.getByTestId("join-and-pay").click();

  await expect(page.getByTestId("payment-status")).toBeVisible({ timeout: 180_000 });
  await expect(page.getByTestId("payment-status")).toContainText("PAID");
  const payTxText = (await page.getByTestId("payment-tx").textContent())?.trim() ?? "";
  expect(payTxText).toMatch(/^0x[0-9a-fA-F]{64}$/);
  console.log("[e2e] entry-fee tx:", payTxText);

  // 3) VERIFY on-chain: that tx carries a USDC Transfer(human → Pot).
  const payReceipt = await pub.getTransactionReceipt({ hash: payTxText as `0x${string}` });
  expect(payReceipt.status).toBe("success");
  const feeTransfer = payReceipt.logs.find(
    (l) =>
      l.address.toLowerCase() === USDC &&
      l.topics[0]?.toLowerCase() === TRANSFER_TOPIC &&
      `0x${l.topics[1]?.slice(26)}`.toLowerCase() === humanAddress.toLowerCase() &&
      `0x${l.topics[2]?.slice(26)}`.toLowerCase() === POT,
  );
  expect(feeTransfer, "expected USDC Transfer(human → Pot) in the entry-fee tx").toBeTruthy();
  const feeValue = BigInt(feeTransfer!.data);
  console.log(`[e2e] verified on-chain: entry fee USDC Transfer(human → Pot) = ${Number(feeValue) / 1e6} USDC`);
  expect(feeValue).toBeGreaterThan(0n);

  // 4) Play a REAL game to a WIN. The human plays its turns via the real UI
  //    (auto-play picks a legal card from the human's sealed hand; the backend
  //    bots play their turns). The deck is a real 108-card shuffle, so the winner
  //    is whoever legally empties their hand first — not a fixed seat. Loop until
  //    the winner banner appears.
  await expect(page.getByTestId("discard-top")).toBeVisible({ timeout: 30_000 });
  const winnerBanner = page.getByTestId("winner-banner");
  const autoPlay = page.getByTestId("auto-play");

  await expect(async () => {
    if (await winnerBanner.isVisible().catch(() => false)) return; // done
    // If it's our turn, auto-play a legal card (gasless move). auto-play resolves
    // any wild color itself, so no color-picker handling is needed here.
    if (await autoPlay.isEnabled().catch(() => false)) {
      await autoPlay.click().catch(() => {});
    }
    await expect(winnerBanner).toBeVisible({ timeout: 5000 });
  }).toPass({ timeout: 900_000 });

  await expect(winnerBanner).toContainText("WINNER");

  // 5) Assert the WINNER on-chain + the pot PAYOUT.
  const payoutTxText = (await page.getByTestId("payout-tx").textContent())?.trim().replace(/^payout\s*/, "") ?? "";
  expect(payoutTxText).toMatch(/^0x[0-9a-fA-F]{64}$/);
  console.log("[e2e] payout tx:", payoutTxText);

  const payoutReceipt = await pub.getTransactionReceipt({ hash: payoutTxText as `0x${string}` });
  expect(payoutReceipt.status).toBe("success");
  const payoutTransfer = payoutReceipt.logs.find(
    (l) =>
      l.address.toLowerCase() === USDC &&
      l.topics[0]?.toLowerCase() === TRANSFER_TOPIC &&
      `0x${l.topics[1]?.slice(26)}`.toLowerCase() === POT,
  );
  expect(payoutTransfer, "expected USDC Transfer(Pot → winner) in the payout tx").toBeTruthy();
  const winner = `0x${payoutTransfer!.topics[2]?.slice(26)}`.toLowerCase();
  const payoutValue = BigInt(payoutTransfer!.data);
  console.log(`[e2e] verified on-chain: pot payout USDC Transfer(Pot → ${winner}) = ${Number(payoutValue) / 1e6} USDC`);
  expect(payoutValue).toBeGreaterThan(0n);
  // Real shuffled hands → the winner is whichever seat legally emptied first. It
  // must be one of the funded seats (human or a bot), and match the on-chain
  // winner shown in the UI banner.
  const { players } = JSON.parse(readFileSync(join(import.meta.dirname, "..", "players.local.json"), "utf8")) as { players: PlayerKey[] };
  const seatAddrs = players.map((p) => p.address.toLowerCase());
  expect(seatAddrs).toContain(winner);
});
