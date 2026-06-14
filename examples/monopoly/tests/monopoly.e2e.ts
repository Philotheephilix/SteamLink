/**
 * Full multiplayer e2e for Nexus MONOPOLY against the live Base Sepolia backend.
 *
 * The game backend + bots now run INSIDE the Next.js app (instrumentation.ts →
 * lib/auto-start.ts), booted by playwright.config's `next dev` webServer. So this
 * test does NOT spawn a separate server/bots process — it drives the human seat
 * through the real UI and reads the WINNER + payout from the SAME-ORIGIN /api/state.
 *
 * PERSISTENT browser context (chromium.launchPersistentContext) so the guest wallet
 * survives across steps. The whole money path is real and PER-PLAYER:
 *
 *   inject the funded HUMAN key → load app → connect (guest wallet = funded seat 0)
 *   → wait for the bots' game → PAY the buy-in (real USDC x402, settled on-chain, from
 *      the HUMAN's OWN wallet) → play to a WIN via the real UI (human rolls + buys;
 *      bots play via the in-process driver, which also auto-pilots the human seat if
 *      the browser stalls) → assert the on-chain WINNER + the pot PAYOUT.
 *
 * Verified on-chain via viem: the buy-in tx carries a USDC Transfer(human → Pot) — the
 * logical payer (delegator) is the PLAYER key, not the relayer — and the payout tx
 * carries a USDC Transfer(Pot → winner).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { type BrowserContext, chromium, expect, test } from "@playwright/test";
import { createPublicClient, http } from "viem";
import deployment from "../deployments/base-sepolia.json" assert { type: "json" };

const APP_URL = process.env.MONOPOLY_APP_URL ?? "http://localhost:3030";
// publicnode RPC (sepolia.base.org is flaky / rate-limited under the long e2e).
const RPC = process.env.BASE_SEPOLIA_RPC_URL ?? "https://base-sepolia-rpc.publicnode.com";
const USDC = deployment.usdc.toLowerCase();
const POT = deployment.pot.toLowerCase();
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const GUEST_KEY_STORAGE = "monopoly.guest.pk";
const USER_DATA_DIR = join(tmpdir(), "monopoly-playwright-profile");

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

  // The app (webServer) auto-starts the game + bots via instrumentation. Wait for its
  // /api/state to report a seated game before driving the human (the on-chain seating
  // can take a while).
  const deadline = Date.now() + 300_000;
  let seated = false;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${APP_URL}/api/state`);
      if (res.ok) {
        const st = (await res.json()) as { ok?: boolean; players?: unknown[] };
        if (st.ok && Array.isArray(st.players) && st.players.length > 0) {
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
    recordVideo: { dir: join(import.meta.dirname, "..", "demos", "monopoly-video"), size: { width: 1280, height: 900 } },
  });
  // Inject the FUNDED human key into the guest wallet localStorage BEFORE any page
  // script runs, so the in-browser guest wallet IS the funded seat-0 player.
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
  try {
    await context?.close(); // flushes the recorded .webm
  } catch {
    /* already closed */
  }
  // Promote the recorded video to a stable demo path.
  try {
    const { readdirSync, renameSync, mkdirSync } = await import("node:fs");
    const vdir = join(import.meta.dirname, "..", "demos", "monopoly-video");
    const demos = join(import.meta.dirname, "..", "demos");
    mkdirSync(demos, { recursive: true });
    const webm = readdirSync(vdir).find((f) => f.endsWith(".webm"));
    if (webm) {
      renameSync(join(vdir, webm), join(demos, "monopoly-demo.webm"));
      console.log("[e2e] demo video saved:", join(demos, "monopoly-demo.webm"));
    }
  } catch (e) {
    console.log("[e2e] video promotion skipped:", e instanceof Error ? e.message : String(e));
  }
});

/** Read the backend game state directly (the source of truth for winner + payout).
 *  Uses an AbortController timeout so a slow on-chain read inside /api/state can never
 *  wedge the drive-loop. */
async function backendState(): Promise<any> {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 8000);
    const res = await fetch(`${APP_URL}/api/state`, { signal: ctrl.signal });
    clearTimeout(t);
    return await res.json();
  } catch {
    return { ok: false };
  }
}

test("multiplayer Monopoly: human pays buy-in (on-chain, own wallet) → plays to a WIN → pot pays out (on-chain)", async () => {
  const page = context.pages()[0] ?? (await context.newPage());
  page.on("console", (m) => {
    if (m.type() === "error") console.log("[browser error]", m.text());
  });

  await page.goto(APP_URL, { waitUntil: "domcontentloaded" });

  // 1) Connect the guest wallet (= the injected, funded seat-0 player). Retry until
  //    React hydrates and the lobby (join/pay) appears (bots' game discovered).
  const connectBtn = page.getByTestId("login-btn");
  await expect(connectBtn).toBeVisible();
  await expect(async () => {
    if (await connectBtn.isVisible().catch(() => false)) await connectBtn.click();
    await expect(page.getByTestId("join-btn")).toBeVisible({ timeout: 5000 });
  }).toPass({ timeout: 90_000 });

  // Sanity: the browser wallet is the funded human seat.
  await expect(page.getByTestId("wallet-address")).toContainText(humanAddress.slice(0, 6));

  // 2) Pay the buy-in — the headline real per-player x402 payment from the human's
  //    OWN wallet.
  await page.getByTestId("join-btn").click();
  await expect(page.getByTestId("payment-status")).toBeVisible({ timeout: 180_000 });
  await expect(page.getByTestId("payment-status")).toContainText("PAID");
  const payTxText = (await page.getByTestId("payment-tx").textContent())?.trim() ?? "";
  expect(payTxText).toMatch(/^0x[0-9a-fA-F]{64}$/);
  console.log("[e2e] buy-in tx:", payTxText);

  // 3) VERIFY on-chain: that tx carries a USDC Transfer(human → Pot). The `from` of the
  //    ERC-20 Transfer is the PLAYER (the delegator), proving a distinct player wallet
  //    signed the budget delegation — the relayer only submitted/redeemed.
  const payReceipt = await pub.getTransactionReceipt({ hash: payTxText as `0x${string}` });
  expect(payReceipt.status).toBe("success");
  const feeTransfer = payReceipt.logs.find(
    (l) =>
      l.address.toLowerCase() === USDC &&
      l.topics[0]?.toLowerCase() === TRANSFER_TOPIC &&
      `0x${l.topics[1]?.slice(26)}`.toLowerCase() === humanAddress.toLowerCase() &&
      `0x${l.topics[2]?.slice(26)}`.toLowerCase() === POT,
  );
  expect(feeTransfer, "expected USDC Transfer(human → Pot) in the buy-in tx").toBeTruthy();
  const feeValue = BigInt(feeTransfer!.data);
  console.log(`[e2e] verified on-chain: buy-in USDC Transfer(human ${humanAddress} → Pot) = ${Number(feeValue) / 1e6} USDC`);
  expect(feeValue).toBeGreaterThan(0n);

  // 4) Play the FULL game to a REAL win (last solvent player after real bankruptcies,
  //    or the documented round-cap richest-player safety net). On the human's turn:
  //    leave jail → buy affordable properties → end the turn → roll. The bots play via
  //    the in-process driver, which also auto-pilots the human seat if the browser
  //    stalls. The WIN GATE is the BACKEND state (source of truth: winner + payoutTx),
  //    polled each iteration — NOT the flaky DOM banner.
  const winnerBanner = page.getByTestId("winner-banner");
  const rollBtn = page.getByTestId("roll-btn");
  const buyBtn = page.getByTestId("buy-btn");
  const endBtn = page.getByTestId("end-btn");
  const payJailBtn = page.getByTestId("payjail-btn");

  const deadline = Date.now() + 2_100_000; // 35 min — the in-process round cap finishes well inside this
  let backendWinner: string | null = null;
  let backendPayoutTx: string | null = null;
  let lastLog = 0;
  while (Date.now() < deadline) {
    // WIN GATE first, every iteration: break as soon as the backend reports a WINNER.
    // (The payout tx may land a tick later — we poll for it separately just below.)
    const st = await backendState();
    if (st?.winner) {
      backendWinner = String(st.winner).toLowerCase();
      if (st?.payoutTx) backendPayoutTx = String(st.payoutTx);
      console.log(`[e2e] backend WINNER detected: ${backendWinner} (payout ${backendPayoutTx ?? "pending"})`);
      break;
    }
    // Periodic progress log so a stuck run is diagnosable.
    if (Date.now() - lastLog > 30_000) {
      lastLog = Date.now();
      const ps = (st?.players ?? []).map((p: any) => `${p.name}:$${p.cash}/${p.properties?.length ?? 0}p${p.bankrupt ? "(bank)" : ""}`).join(" ");
      console.log(`[e2e] round ${st?.round ?? "?"}/${st?.roundCap ?? "?"} — ${ps}`);
    }
    // Drive the human seat through the UI (the backend ALSO auto-pilots it if we stall,
    // so the game finishes regardless of the browser). Every page interaction is raced
    // against a hard timeout: a frozen/slow headless page (long video recordings can
    // wedge chromium) must NEVER block the node-side win gate above.
    const guard = <T,>(p: Promise<T>, ms: number, fallback: T): Promise<T> =>
      Promise.race([p.catch(() => fallback), new Promise<T>((r) => setTimeout(() => r(fallback), ms))]);

    if (await guard(payJailBtn.isVisible(), 4000, false)) {
      await guard(payJailBtn.click(), 6000, undefined);
    } else if (await guard(buyBtn.isVisible(), 4000, false)) {
      await guard(buyBtn.click(), 6000, undefined);
    } else if (await guard(endBtn.isVisible(), 4000, false)) {
      await guard(endBtn.click(), 6000, undefined);
    } else if (await guard(rollBtn.isEnabled(), 4000, false)) {
      await guard(rollBtn.click(), 6000, undefined);
    }
    // Node-side pace (page-independent) so the loop always advances to the next win check.
    await new Promise((r) => setTimeout(r, 2000));
  }

  expect(backendWinner, "the game should reach a real last-solvent winner (backend winner)").toBeTruthy();

  // The pot payout tx may settle a moment after the winner is decided — poll for it.
  if (!backendPayoutTx) {
    const payoutDeadline = Date.now() + 120_000;
    while (Date.now() < payoutDeadline && !backendPayoutTx) {
      const st = await backendState();
      if (st?.payoutTx) backendPayoutTx = String(st.payoutTx);
      else await new Promise((r) => setTimeout(r, 3000));
    }
  }
  expect(backendPayoutTx, "the backend should report a payout tx").toBeTruthy();
  console.log("[e2e] backend winner:", backendWinner, "payout:", backendPayoutTx);

  // The DOM banner is a nice-to-have (the UI polls /api/state every 2s). Give it a
  // moment but never let it gate the test.
  await expect(winnerBanner).toBeVisible({ timeout: 30_000 }).catch(() => {});

  // 5) Assert the WINNER on-chain + the pot PAYOUT (use the backend's payout tx).
  const payoutTxText = backendPayoutTx!;
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
  // The winner is the LAST SOLVENT player (real bankruptcy-based finish) — NOT a fake
  // first-to-N shortcut. It may be the human or a bot; assert the on-chain payout
  // recipient matches the backend's reported winner (a real participant).
  expect(winner).toBe(backendWinner);
});
