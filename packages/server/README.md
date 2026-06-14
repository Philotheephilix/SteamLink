# @steamlink/server

> x402 payment middleware for Nexus game endpoints — monetize HTTP routes, settle on Base.

## What it is

`@steamlink/server` puts an [x402](https://www.x402.org/) paywall in front of your
HTTP endpoints. Use it to charge entry fees, paid actions, or any monetized route:
a request with no payment gets a `402` challenge; a request carrying a valid
redemption is verified on-chain and allowed through.

The verification work sits behind a **`FacilitatorAdapter` port**, so your route
code never touches a concrete provider. The default `DelegationFacilitator` is
*delegation-aware*: instead of demanding a fresh payment signature, it redeems the
player's existing session delegation — the single ERC-7710 grant they signed once
at `joinRoom()`, bounded by their on-chain budget caveats. Payments settle in USDC
on **Base**, and the token address is resolved from relayer capabilities (never
hardcoded).

The middleware is framework-agnostic at its core, with thin adapters for **Express**
and **Hono**.

## Install

```bash
npm install @steamlink/server
```

## Key exports

**Monetize middleware**

- `monetize` — the canonical middleware factory (defaults to the Express adapter).
- `monetizeExpress(opts, runtime?)` — Express middleware: `402` on missing/invalid
  payment, attaches `req.settlement` and calls `next()` on success.
- `monetizeHono(opts, runtime?)` — Hono middleware: returns the `402` JSON, or
  stashes the settlement via `c.set("settlement", …)` and calls `next()` on success.
- `createMonetizeHandler(opts, runtime?)` — the framework-agnostic handler the
  adapters wrap; returns `(req) => Promise<MonetizeResult>`.
- `statusForError(err)` — maps a `NexusError` to the HTTP status the middleware uses.
- `PAYMENT_HEADER` (`"x-payment"`), `PAYER_HEADER` (`"x-payer"`) — header names by convention.

Types: `MonetizeOptions`, `MonetizeRuntime`, `MonetizeRequest`, `MonetizeResult`
(`Challenge402Result | RejectResult | PassResult`), and the per-framework types
`ExpressMiddleware` / `ExpressRequestLike` / `ExpressResponseLike` / `ExpressNext`
and `HonoMiddleware` / `HonoContextLike` / `HonoNext`.

**Facilitator (the x402 seller side)**

- `FacilitatorAdapter` — the port: `challenge(req)` builds the `402` body and mints
  a single-use nonce; `verify(redemption)` confirms settlement on Base (idempotent
  on the nonce).
- `DelegationFacilitator` — the default delegation-aware adapter.
- `DelegationFacilitatorConfig` — its config (capabilities resolver, Base public
  client, nonce store, TTL, min confirmations, recipient authorization).
- `DEFAULT_MIN_CONFIRMATIONS`.
- Port data types: `PaymentRequest`, `Challenge402`, `Redemption`, `Settlement`.

**Settlement verification**

- `verifyTransferOnChain(params)` — reads the receipt and confirms the ERC-20 transfer.
- Types: `ReceiptReaderClient`, `TransactionReceiptLike`, `LogLike`, `VerifyTransferParams`.

**Nonce store (replay protection)**

- `InMemoryNonceStore`, `randomNonce`, `DEFAULT_NONCE_TTL_MS`.
- Types: `NonceStore`, `NonceRecord`.

## Usage

`monetize()` returns Express middleware. The `runtime` supplies the default
facilitator selected by `facilitator: "nexus"`. The price/asset config is set
per-route:

```ts
import express from "express";
import { monetize, DelegationFacilitator } from "@steamlink/server";

const facilitator = new DelegationFacilitator({
  // capabilities are the source of truth for the token address + targetAddress
  capabilities: () => relayer.getCapabilities(),
  publicClient, // a viem public client on Base
});

const app = express();
app.use(express.json());

app.post(
  "/rooms/:id/join",
  monetize(
    {
      price: "5", // human units, e.g. 5 USDC
      token: "USDC", // resolved to an address from capabilities
      chain: "base", // Base only
      recipient: "0xPotOrSeller", // must be in the payer's budget caveat
      facilitator: "nexus", // use the default DelegationFacilitator from runtime
      reason: "Room entry fee",
    },
    { defaultFacilitator: facilitator },
  ),
  (req, res) => {
    // Payment verified — req.settlement holds the on-chain Settlement.
    res.json({ joined: true, txHash: req.settlement!.txHash });
  },
);
```

For Hono, use `monetizeHono(...)` with the same `MonetizeOptions`; the verified
settlement is read with `c.get("settlement")`. You can also pass a concrete
`FacilitatorAdapter` directly as `facilitator` instead of the `"nexus"` literal.

The middleware expects an authenticated payer (the player's smart account),
resolved from `req.payer` or the `x-payer` header set by the gateway's auth layer.
A redemption is bound to that payer before any settlement is accepted — it is not a
bearer token.

## Part of Nexus

This is the library for putting x402 in front of **your** endpoints. It pairs with:

- [`@steamlink/core`](../core) — game definition, ECS, client, and the delegation engine.
- [`@steamlink/relayer`](../relayer) — the 1Shot relayer client whose capabilities
  supply the payment token address and `targetAddress`.

**Base only.** `chain` is strictly `"base"` and settlement happens in USDC on Base.
