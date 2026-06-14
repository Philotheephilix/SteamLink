# @steamlink/cli

> Command-line tool to scaffold, deploy, and run Nexus games on Base.

## What it is

The CLI for the Nexus SDK — a fully onchain, turn-based game engine for Base. It lets
you scaffold a new game project (tables + systems + config), generate the Solidity
table glue and manifest from your `defineGame` module, deploy the World + systems +
enforcers, migrate system logic without touching stored tables, and boot a local Base
fork to develop the whole stack with zero credentials. You describe your game as data
and logic; the CLI handles codegen, deployment, and the local devnet.

## Install

Install globally:

```sh
npm install -g @steamlink/cli
```

The installed binary is named `nexus`, so you invoke commands as `nexus <command>`:

```sh
nexus init my-game
```

Or run it without installing, via `npx`:

```sh
npx @steamlink/cli init my-game
```

## Commands

| Command | Description | Key flags |
|---|---|---|
| `nexus init <name>` | Scaffold a new game project (tables + systems + config) into `<name>/`. | `<name>` — project directory name (lower-kebab/snake) |
| `nexus codegen` | Generate the Solidity tables library + `manifest.json` from a `defineGame` module. | `--game <path>` (default `game/game.ts`), `--out <dir>` (default `nexus.generated`) |
| `nexus deploy` | Deploy World + systems + enforcers from the manifest (via `forge script`). | `--network <base\|base-sepolia>` (required), `--manifest <path>`, `--contracts <dir>`, `--script <target>`, `--dry-run`, `--yes` |
| `nexus migrate` | Upgrade system logic without touching stored tables (re-codegen + repoint registry). | `--network <base\|base-sepolia>` (required), `--only <systems>` (comma-separated), `--contracts <dir>`, `--script <target>`, `--dry-run`, `--yes` |
| `nexus dev` | Boot a local Base fork + the full stack with zero credentials. | `--port <n>` (default `8080`), `--fork-rpc <url>`, `--block <n>`, `--no-fork`, `--dry-run` |
| `nexus fork` | Clone live Base state into a local staging fork (`anvil --fork-url`). | `--from <base\|base-sepolia>` (default `base`), `--at <block>`, `--port <n>` (default `8546`), `--fork-rpc <url>`, `--dry-run` |

`deploy` and `migrate` require a funded `PRIVATE_KEY` in the environment and use
`BASE_RPC_URL` / `BASE_SEPOLIA_RPC_URL` (falling back to the public default).
`fork` reads `WORLD_ADDRESS` to point the staging backend at the forked World.
`deploy`, `migrate`, `dev`, and `fork` rely on Foundry (`forge` / `anvil`) being installed.

## Quick start

```sh
# 1. Scaffold a new game project
nexus init my-game
cd my-game

# 2. Generate the Solidity table glue + manifest from your defineGame module
nexus codegen

# 3. Boot a local Base fork + full stack (no credentials needed)
nexus dev

# 4. When ready, deploy to a real network (needs PRIVATE_KEY + RPC)
nexus deploy --network base-sepolia
```

## Part of Nexus

Part of the Nexus game engine SDK. Base only.
