# SteamLink

[![Docs](https://img.shields.io/badge/Docs-steamlink.vercel.app%2Fdocs-e4572e?logo=readthedocs&logoColor=white&style=for-the-badge)](https://steamlink.vercel.app/docs)
[![Base Sepolia](https://img.shields.io/badge/Base-Sepolia%C2%B784532-0052ff?logo=coinbase&logoColor=white&style=for-the-badge)](https://sepolia.basescan.org)
[![npm @steamlink/core](https://img.shields.io/npm/v/@steamlink/core?label=%40steamlink%2Fcore&style=for-the-badge&color=cb3837&logo=npm)](https://www.npmjs.com/package/@steamlink/core)

**Fully onchain, turn-based games on Base — one signature, then every move is gasless and every
payment is bounded on-chain.** SteamLink is a game-engine SDK (engine name: *Nexus*). A player signs
**one** ERC-7710 delegation when they join a room; a relayer redeems that single signature for
everything after — gasless moves (no wallet popups) and x402 stablecoin payments capped on-chain by
caveats. You describe a game as **data** (tables) and **logic** (Solidity systems); the SDK handles
the cryptography, relaying, randomness, sealed state, and settlement.

Live on Base Sepolia with real transactions; the architecture is mainnet-ready.

---

## What you get

- **One delegation → infinite gasless moves.** The player signs once at join. The relayer submits
  every `redeemDelegations` call and pays gas; the player pays zero gas and signs nothing again.
- **x402 payments with on-chain guardrails.** Entry fees and in-game charges are real USDC transfers
  bounded by the delegation's per-action + lifetime caps — the relayer can never overspend a player.
- **Typed end to end.** A misspelled table fails at compile time; game logic is real Solidity, never
  interpreted in JS.
- **Two wallet rails.** A built-in session/embedded wallet (zero setup), or a real **MetaMask Smart
  Account** that authorizes spend through MetaMask's native ERC-7715 permission popup.
- **Provable + private.** Onchain randomness for shuffles/dice; sealed hidden state (hands,
  fog-of-war) revealed only to its owner.

## Packages

Install only what you need. Every package is published on npm:

| Package | Purpose |
|---|---|
| [@steamlink/core](https://www.npmjs.com/package/@steamlink/core) | `defineGame`, the single-delegation engine, randomness, codegen |
| [@steamlink/react](https://www.npmjs.com/package/@steamlink/react) | React hooks for live game state, moves, and charges |
| [@steamlink/server](https://www.npmjs.com/package/@steamlink/server) | x402 payment middleware (`monetize`) for your endpoints |
| [@steamlink/relayer](https://www.npmjs.com/package/@steamlink/relayer) | Gasless redemption client (capabilities, bundles, webhooks) |
| [@steamlink/secrets](https://www.npmjs.com/package/@steamlink/secrets) | Sealed secret state (hidden hands / fog-of-war) |
| [@steamlink/cli](https://www.npmjs.com/package/@steamlink/cli) | Scaffold, codegen, deploy, migrate, local devnet |
| [@steamlink/types](https://www.npmjs.com/package/@steamlink/types) | Shared branded types + the canonical error taxonomy |

```bash
npm install @steamlink/core @steamlink/react @steamlink/server
```

## How it works in one example — `define`, `move`, `monetize`

```ts
// 1) DEFINE — your game is data (tables) + logic (Solidity systems).
import { defineGame, t } from "@steamlink/core";

export const game = defineGame({
  name: "tic-tac-toe",
  tables: {
    Board: { roomId: t.uint256, cells: t.bytes, turn: t.address },
  },
  systems: {
    PlayMove: "src/systems/PlayMove.sol", // real Solidity — never interpreted in JS
  },
  economy: {
    entryFee: { amount: "1.00", token: "USDC" },
    pot: { type: "winner-take-all", rake: "0.05" },
  },
});
```

```tsx
// 2) MOVE — the player signs ONE delegation at join; every move after is gasless,
//    no popup. `move` redeems that delegation through the relayer, applies an
//    optimistic update, and reconciles on the on-chain result.
import { useGameActions, useTable } from "@steamlink/react";

function PlayMoveButton({ roomId, cell }: { roomId: bigint; cell: number }) {
  const { move, isPending } = useGameActions();
  const { data: board } = useTable("Board", { roomId }); // live, optimistic
  return (
    <button
      disabled={isPending}
      onClick={() => move("PlayMove", { roomId, cell })} // gasless redemption
    >
      Play cell {cell}
    </button>
  );
}
```

```ts
// 3) MONETIZE — put an x402 paywall on any endpoint. The charge settles as a real
//    USDC transfer to your Pot, bounded by the player's budget caveats — no popup,
//    no gas for the player.
import express from "express";
import { monetize } from "@steamlink/server";

const app = express();
app.post(
  "/api/premium-hint",
  monetize({ price: "0.10", token: "USDC", chain: "base", recipient: POT_ADDRESS, facilitator: "nexus" }),
  (req, res) => res.json({ hint: "play the center", settlement: req.settlement }),
);
```

That's the whole surface: **`defineGame`** declares the game, **`move`** redeems the single
delegation for a gasless action, **`monetize`** charges bounded USDC over x402.

## Live deployments (Base Sepolia · chain 84532)

Two reference games are deployed and playable end to end (buy-in → gasless play → onchain winner →
pot payout). Click any address to open it on Basescan.

**UNO** — full 108-card ruleset:

| Contract | Address |
|---|---|
| DelegationManager | [0x4a98…fa7f](https://sepolia.basescan.org/address/0x4a984AA64eA35817401C020Bc69E39d5A3d5fa7f) |
| World | [0xd664…7D4a](https://sepolia.basescan.org/address/0xd664e99581699d5Af07C45BB6D417DFa2fb17D4a) |
| Pot | [0xae0f…7C3b](https://sepolia.basescan.org/address/0xae0f54144FBF14992041842e24EdA0eAC9567C3b) |
| RandomnessCoordinator | [0x6550…c18b](https://sepolia.basescan.org/address/0x6550643c46782d44dF196af227E98C3273Abc18b) |

**Monopoly** — full 40-space ruleset:

| Contract | Address |
|---|---|
| DelegationManager | [0x9C1d…8eD5](https://sepolia.basescan.org/address/0x9C1d2B181D9D242cCC0C86B14dADe8153E688eD5) |
| World | [0x0340…8f9C](https://sepolia.basescan.org/address/0x034096F54d1f09aB5dF7967f0E7B06Ea44ef8f9C) |
| Pot | [0x8710…9Ad7](https://sepolia.basescan.org/address/0x87109EAe342Ee671028d6259fDd0A8Aa7c729Ad7) |
| RandomnessCoordinator | [0xA3A5…ad63](https://sepolia.basescan.org/address/0xA3A54D08F0F776E5Ad51b53187956242024Cad63) |

Shared: the payment token is Circle's Base-Sepolia USDC
[0x036C…CF7e](https://sepolia.basescan.org/address/0x036CbD53842c5426634e7929541eC2318f3dCF7e). The
optional MetaMask ERC-7715 rail settles through MetaMask's canonical DelegationManager
[0xdb9B…7dB3](https://sepolia.basescan.org/address/0xdb9B1e94B5b69Df7e401DDbedE43491141047dB3).

## Run a reference game locally

```bash
pnpm install
pnpm --filter @nexus/example-uno dev   # http://localhost:3100 — boots the game + bots, plays itself
```

Open the URL, connect a wallet, and play. The app auto-seats a table against bots; you sign one
delegation and every move + payment settles on-chain, gaslessly.

## Documentation

Full docs — the **SDK reference** (every `@steamlink/*` module and method) and the **Contribute a
game** guide — live at **[steamlink.vercel.app/docs](https://steamlink.vercel.app/docs)**.

## Contributing — add a game

Want a new game on the shelf, like UNO or Monopoly? The complete, step-by-step walkthrough is the
**Contribute a game** tab in the docs:

**→ [steamlink.vercel.app/docs](https://steamlink.vercel.app/docs)**

The short version:

1. **Fork & branch** — fork this repo, `git checkout -b feat/<your-game>`.
2. **Define** — `defineGame(...)` your tables + Solidity system paths in `web/lib/<game>/game.ts`.
3. **Write systems** — real Solidity under `packages/contracts/src/systems/`; `forge test` them.
4. **Deploy** — deploy the World + systems to Base Sepolia; record addresses in
   `web/lib/<game>/deployments/base-sepolia.json`.
5. **Wire the backend** — namespaced handlers in `web/app/api/<game>/*`, booted from
   `web/instrumentation.ts`.
6. **Add the UI** — `web/app/play/<game>/page.tsx` on the shared `useWallet()` provider, with every
   tx hash rendered through `linkifyTx`.
7. **Register** — add a `GameEntry` to `GAMES` in `web/lib/games.ts` with `status: "live"`.
8. **Verify** — `forge test` · `pnpm -r test` · `pnpm --filter @steamlink/web build` must all pass.

### Open a pull request

Push your branch and open a PR against `main`:

```bash
git push origin feat/<your-game>
gh pr create --base main --title "feat: add <Your Game>" \
  --body "New in-tree game. Deployed to Base Sepolia. One delegation, gasless moves, x402 entry."
```

Or from the compare view:
**[github.com/Philotheephilix/SteamLink/compare](https://github.com/Philotheephilix/SteamLink/compare)**.
Describe the game, link the deployed contract addresses, and confirm the PR checklist in the docs.
**Never commit funded keys or `.env.local`** — they're gitignored, and a committed key is an automatic
rejection.

## License

MIT.
</content>
