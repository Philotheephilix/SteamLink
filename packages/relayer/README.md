# @steamlink/relayer

> Gasless transaction relaying for Nexus — redeem ERC-7710 delegations; gas paid in stablecoins.

## What it is

The relayer adapter behind a single TypeScript Port. Every redemption — a gameplay
move or an x402 payment — reaches Base through one `RelayerAdapter` interface, so
players pay **zero gas**.

Two implementations ship in the box:

- **`OneShotRelayer`** — the production adapter against the 1Shot Permissionless
  Relayer API. Gas is paid in a stablecoin drawn from on-chain capabilities, plain
  EOAs are upgraded in place via EIP-7702, and status is webhook-driven (with a
  polling fallback when no webhook URL is configured).
- **`DirectRelayer`** — a zero-credential, self-relay adapter that broadcasts real
  transactions with a funded viem wallet. The live default for tests and local/dev
  deployments where no external relayer account exists.

Both satisfy `RelayerAdapter`, so game code targets the port and never touches a
concrete provider.

## Install

```bash
npm install @steamlink/relayer
```

## Key exports

**Port (interface + types) — `./port.js`**

- `RelayerAdapter` — the adapter interface: `getCapabilities`, `submitBundle`,
  `onStatus`, `upgradeEOA`.
- `RelayerCapabilities` — `chains`, `tokens`, `feeCollector`, `targetAddress`.
- `Bundle` — a redemption to relay: `delegationContext`, `encodedTxns`,
  `eip7702Auth`, `destinationUrl`, `requireTarget`, `idempotencyKey`.
- `EncodedCall` — a `{ to, data, value? }` triple.
- `BundleHandle` — `{ bundleId, txHash? }` returned by `submitBundle`.
- `BundleStatus` — `"pending" | "mined" | "failed"`.
- `StatusEvent` — terminal status delivered to `onStatus` listeners.
- `Unsubscribe` — the teardown function returned by `onStatus`.
- `Eip7702Authorization` / `UpgradeResult` — EOA upgrade input/output.

**1Shot adapter — `./oneshot.js`**

- `OneShotRelayer` — the production `RelayerAdapter` implementation.
- `signWebhook(secret, rawBody)` — HMAC-SHA256 webhook signer (for signing test
  deliveries / verification).
- `OneShotRelayerConfig`, `OneShotWebhookPayload`, `WebhookHeaders`, `FetchImpl` —
  configuration and webhook types.

**Direct adapter — `./direct.js`**

- `DirectRelayer` — the self-relay `RelayerAdapter` implementation.
- `revertDataOf(err)` — extract revert-data hex from a viem error for structural
  decoding upstream.
- `DirectRelayerConfig` — configuration type.

## Usage

```ts
import {
  OneShotRelayer,
  DirectRelayer,
  type Bundle,
} from "@steamlink/relayer";

// Production: the 1Shot permissionless relayer (gas in stablecoin, EIP-7702).
const relayer = new OneShotRelayer({
  apiKey: process.env.ONESHOT_API_KEY!,
  apiSecret: process.env.ONESHOT_API_SECRET!,
  endpoint: "https://api.1shotapi.com/v1",
  webhookUrl: "https://your-backend.example/nexus/webhook",
});

// Capabilities are the source of truth — read tokens + targetAddress, never hardcode.
const caps = await relayer.getCapabilities();
const usdc = caps.tokens.USDC;

// Subscribe to terminal status (webhook-driven).
const unsubscribe = relayer.onStatus((e) => {
  console.log(e.bundleId, e.status, e.txHash);
});

// Submit a delegation redemption — the player pays no gas.
const bundle: Bundle = {
  delegationContext: "0x…",
  encodedTxns: [{ to: caps.targetAddress, data: "0x…" }],
};
const { bundleId } = await relayer.submitBundle(bundle);

unsubscribe();
```

For local/dev, swap in `DirectRelayer` with a funded viem wallet — same interface,
no credentials:

```ts
const relayer = new DirectRelayer({ wallet, publicClient, usdc });
```

## Conventions

- **Capabilities are the source of truth.** Read fee/payment `tokens` and the
  relayer `targetAddress` from `getCapabilities()` (which calls
  `relayer_getCapabilities`) and cache them — never hardcode tokens. `OneShotRelayer`
  memoizes capabilities for the process lifetime and rejects a `targetAddress`
  mismatch (`TARGET_MISMATCH`) before broadcasting; a money bundle
  (`requireTarget: true`) whose target can't be determined is hard-rejected, never
  submitted unguarded.
- **Webhooks drive status.** Terminal status flows from 1Shot webhooks →
  `StatusEvent` via `ingestWebhook` (HMAC-verified over the raw signed body,
  deduped). Polling `getStatus` is a silent fallback only when no `webhookUrl` is set.
- **Idempotent money bundles.** A retried submit carrying the same `idempotencyKey`
  returns the original handle instead of paying twice.

## Part of Nexus

Built for [`@steamlink/core`](../core). **Base only** — `chain` is strictly `"base"`.
