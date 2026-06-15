# web/ — the Steamlink mono-app (navigation map)

> The Next.js 15 (App Router) app that is the marketing site, the `/docs` page,
> AND both reference games (UNO + Monopoly) in one deployment. Package name
> `@steamlink/web`. Parent map: [`../AGENTS.md`](../AGENTS.md). Server-only game
> code imports the published `@steamlink/*` SDK packages.

## How one process serves everything

`instrumentation.ts` runs once on server boot (Node runtime only — gated on
`process.env.NEXT_RUNTIME === "nodejs"`) and imports `./lib/uno/auto-start` and
`./lib/monopoly/auto-start`, which seat a bot table for each game so a visitor can
play immediately. `next.config.mjs` transpiles the `@steamlink/*` packages and
stubs node builtins for the edge runtime.

## Routes (`app/`)

| Route | File | What |
|---|---|---|
| `/` | `app/page.tsx` | Landing site (Gamer/Dev modes). Components in `components/*`. |
| `/docs` | `app/docs/page.tsx` | Two-division docs: **SDK reference** (`components/docs/SdkDocs.tsx`) + **Contribute a game** (`components/docs/ContributeDocs.tsx`). Chrome + scroll-spy in `components/docs/DocsShell.tsx`; copy-button code blocks in `components/docs/CodeBlock.tsx`. |
| `/play/uno` | `app/play/uno/page.tsx` | UNO client UI (uses `useWallet()`). |
| `/play/monopoly` | `app/play/monopoly/page.tsx` | Monopoly client UI. |
| `/api/uno/*` | `app/api/uno/{start,state,move,hand,charge,grant,new-game,health}/route.ts` | UNO backend handlers. |
| `/api/monopoly/*` | `app/api/monopoly/{start,state,act,join,grant,health}/route.ts` | Monopoly backend handlers. |

API routes are **namespaced per game** (`/api/uno/*`, `/api/monopoly/*`) to avoid
collisions in the merged app.

## Shared infrastructure (`lib/` + `components/`)

- `lib/wallet.ts` — the **shared connector** for the whole app: `connectMetaMask`
  (MetaMask Hybrid DeleGator smart account + Pimlico bundler), `connectGuest`
  (localStorage viem account), `Connection.ensureApproval`.
- `components/wallet/WalletProvider.tsx` — `useWallet()` React context (connection,
  grant, connect/disconnect), mounted in `app/layout.tsx`.
- `lib/erc7715.ts` — shared ERC-7715 grant rail (`connectMetaMaskGrant`).
- `lib/constants.ts` — chain-level constants (USDC + relayer address).
- `lib/games.ts` — the catalog (`GAMES`) that drives the home shelf; adding a game
  is a registry edit (`status: "live"` → routes to `/play/<slug>`).
- `components/linkifyTx.tsx` — renders any `0x…64hex` tx hash as a basescan link.

## Per-game backend (`lib/uno/`, `lib/monopoly/`) — SERVER ONLY

Each game folder is a self-contained, server-only backend. **Never import these
from a `"use client"` component** — they hold the funded relayer key. Mirrored
layout:

| File | Role |
|---|---|
| `config.ts` | Server config: relayer key (hardcoded **testnet-only**, env-overridable), RPC, chain id, USDC, fee. Monopoly also: `RELAYER_MODE` flag (`direct` \| `oneshot`) + 1Shot endpoint/bearer. |
| `deployment.ts` + `deployments/base-sepolia.json` | Deployed addresses (World, manager, enforcers, Pot, randomness, game system, relayer, usdc). |
| `engine.ts` | Low-level redemption engine: `redeemRoll`/`redeemAction`/`redeemMove`, `chargeFromPlayer`, admin ops (`startTurns`, `openPot`, `settlePot`). The single submit choke point. Monopoly's `submitRedemption` branches on the relayer rail. |
| `game-backend.ts` | Authority singleton: holds the live game, charges entries, redeems moves, settles. |
| `<game>-rules.ts` / `<game>-game.ts` | Authoritative game state machine. |
| `delegations.ts` | **Browser-safe** delegation signing (pure `@steamlink/core` + viem; no relayer key). |
| `signer.ts` | Wallet abstraction (MetaMask smart account / guest). |
| `erc7715.ts` / `erc7715-settle.ts` | The ERC-7715 grant rail (rail (b)). |
| `auto-start.ts` | Boots a bot table on server start (called from `instrumentation.ts`). |
| `bot-runner.ts` / `bot-strategy.ts` | In-process bot players. |
| `ensure-players.ts` | Generates/loads funded player keys (`players.*.local.json`, gitignored). |

### Monopoly's 1Shot rail (`lib/monopoly/oneshot-relayer.ts`)
Behind `MONOPOLY_RELAYER=oneshot`, redemptions route through a vendored
`OneShotPublicRelayer` (the 1Shot Permissionless Public Relayer JSON-RPC) instead
of the funded-key self-relay. `engine.ts` runs a boot capability guard that warns
if the 1Shot `targetAddress` won't accept the demo delegations. Default `direct`
is unchanged.

## Secrets / do-not-commit

Funded keys and env live outside git: `web/.env.local` (Pimlico/bundler key),
`**/players.*.local.json` (funded player keys). All gitignored. The hardcoded
relayer key in `lib/<game>/config.ts` is **testnet-only** and intentional for the
self-contained demo — rotate before any mainnet use.
