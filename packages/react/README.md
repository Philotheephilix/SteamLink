# @steamlink/react

React hooks for live Nexus game state — optimistic UI, on-chain truth.

## What it is

React bindings for Nexus. A single provider holds your client config and one
subscription manager; a set of hooks subscribe to live game state, apply
optimistic updates the instant a player acts, and reconcile against the truth
when the relayer webhook lands. Enforcer rejections never surface as raw reverts
— they come back as typed `NexusError`s (e.g. `NOT_YOUR_TURN`, `BUDGET_EXCEEDED`).

Built for Base, one delegation per player per room: the only wallet prompt in the
whole UI lives in `join` — every move and charge after that is gasless.

## Install

```bash
npm install @steamlink/react
```

`react` (`^18 || ^19`) is a peer dependency — install it alongside if you haven't
already.

## Setup

Wrap your app in `NexusProvider` and pass it a `config`:

```tsx
import { NexusProvider } from "@steamlink/react";
import type { NexusClientConfig } from "@steamlink/react";

const config: NexusClientConfig = {
  chain: "base",
  world: "0x…", // deployed World address
  addresses, // DeploymentAddresses: delegation manager + enforcers
  signer, // viem LocalAccount (smart-account owner); optional for read-only/SSR
  transport, // the seam to the gateway/indexer/relayer
};

export function App() {
  return (
    <NexusProvider config={config}>
      <Game />
    </NexusProvider>
  );
}
```

## Hooks

- **`useNexus()`** — access the client config + subscription manager from
  context; throws if used outside `<NexusProvider>`. Other hooks build on it.
- **`useTable(table, where)`** — live, auto-synced table read with optimistic
  overlays applied; returns `{ data, status, loading, error, isOptimistic }`.
- **`useGameActions()`** — exposes `move(...)`, which builds a redemption through
  the delegation engine, applies an optimistic overlay, submits, and awaits
  reconciliation; returns `{ move, isPending, pending, lastError }`.
- **`useCharge()`** — x402 monetization against the session's budget caveats (no
  popup); optimistically decrements `remaining`, rolls back on `BUDGET_EXCEEDED`.
  Returns `{ charge, isCharging, remaining, lastError }`.
- **`useSession()`** — reactive view of the current room session; `join` carries
  the single per-room delegation prompt. Returns `{ session, account, isJoining,
  join, leave, budget, expiresAt, error }`.
- **`useTurn(roomId)`** — the room's current turn; derives `isMyTurn` and runs a
  cosmetic countdown. Returns `{ current, isMyTurn, deadline, secondsLeft,
  direction, isExpired, status }`.
- **`usePot(roomId)`** — live pot balance + `settle`/`open` actions, read from the
  indexed `Pot` table. Returns `{ balance, rake, status, settle, open }`.

Read state and send a gasless move:

```tsx
import { useTable, useGameActions } from "@steamlink/react";

function Game() {
  const { data: cards, isOptimistic } = useTable("Hand", { roomId: 1n });
  const { move, isPending, lastError } = useGameActions();

  async function playCard(systemId: `0x${string}`) {
    await move("PlayCard", systemId, {
      roomId: 1n,
      optimistic: {
        table: "Hand",
        where: { roomId: 1n },
        mutate: (rows) => rows.slice(1), // predicted transform
      },
    });
  }

  if (lastError) return <p>{lastError.code}</p>;
  return <button disabled={isPending} onClick={() => playCard("0x…")}>Play</button>;
}
```

## Optimistic UI

Apply optimistic updates the moment a player acts, then reconcile on the relayer
webhook: a `mined` status confirms the overlay, a `failed` status rolls it back.
On-chain truth always wins — enforcer rejections surface as typed `NexusError`s
(e.g. `NOT_YOUR_TURN`, `BUDGET_EXCEEDED`) rather than raw reverts.

## Part of Nexus

- [`@steamlink/core`](../core) — game definition, ECS, client, delegation engine.

Base only. `chain` is strictly `"base"`.
