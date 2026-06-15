import { CodeBlock } from "./CodeBlock";
import { Section, PageTitle, H2, H3, P, Lead, C, Callout, Step, Pills, Ul, Li } from "./prose";
import type { NavGroup } from "./DocsShell";

const REPO = "https://github.com/Philotheephilix/SteamLink";

export const CONTRIBUTE_NAV: NavGroup[] = [
  {
    group: "Before you start",
    items: [
      { id: "c-overview", label: "Overview" },
      { id: "c-anatomy", label: "Anatomy of a game" },
      { id: "c-prereqs", label: "Prerequisites" },
    ],
  },
  {
    group: "Build your game",
    items: [
      { id: "c-fork", label: "1 · Fork & branch" },
      { id: "c-define", label: "2 · Define the game" },
      { id: "c-systems", label: "3 · Write systems" },
      { id: "c-deploy", label: "4 · Deploy to Base" },
      { id: "c-backend", label: "5 · Backend wiring" },
      { id: "c-route", label: "6 · Route & UI" },
      { id: "c-catalog", label: "7 · Register in catalog" },
    ],
  },
  {
    group: "Ship it",
    items: [
      { id: "c-test", label: "8 · Build & test" },
      { id: "c-pr", label: "9 · Open the PR" },
      { id: "c-checklist", label: "PR checklist" },
    ],
  },
];

export function ContributeDocs() {
  return (
    <>
      <Section id="c-overview">
        <PageTitle kicker="Contribute">Add a new game</PageTitle>
        <Lead>
          UNO and Monopoly both live in this repo as first-class, in-tree games. Adding a third works
          the same way: describe it as tables + Solidity systems, deploy to Base Sepolia, wire a
          backend, drop in a route, and register it in the catalog. This page walks the whole path
          from fork to merged PR.
        </Lead>
        <Callout tone="rule" title="The one rule that never bends">
          A player signs <strong>one</strong> delegation when they join your room. No flow may
          re-prompt the wallet mid-game. Every move and every charge redeems that single signature —
          if your design needs a second popup, rethink it.
        </Callout>
      </Section>

      <Section id="c-anatomy">
        <H2>Anatomy of a game</H2>
        <P>
          A game in this repo is split across the monorepo. Mirror how <C>web/lib/uno</C> and{" "}
          <C>web/lib/monopoly</C> are laid out:
        </P>
        <Ul>
          <Li>
            <C>defineGame(...)</C> — the data + logic schema (tables, systems, economy).
          </Li>
          <Li>
            <C>*.sol</C> systems + caveat enforcers in <C>packages/contracts</C>, deployed to Base
            Sepolia.
          </Li>
          <Li>
            <C>web/lib/&lt;game&gt;/</C> — engine, rules, bot runner, config, deployment addresses,
            auto-start, and the API client.
          </Li>
          <Li>
            <C>web/app/api/&lt;game&gt;/*</C> — namespaced route handlers (start, state, move/act,
            grant, …).
          </Li>
          <Li>
            <C>web/app/play/&lt;game&gt;/page.tsx</C> — the client UI, on the shared wallet provider.
          </Li>
          <Li>
            An entry in <C>web/lib/games.ts</C> — the catalog that drives the home shelf.
          </Li>
        </Ul>
        <Callout tone="tip" title="Copy the closest game">
          Building a card game? Start from <C>web/lib/uno</C>. A board/economy game? Start from{" "}
          <C>web/lib/monopoly</C>. Copy the folder, rename, and replace the rules — the delegation,
          relayer, and auto-start plumbing already work.
        </Callout>
      </Section>

      <Section id="c-prereqs">
        <H2>Prerequisites</H2>
        <Pills items={["Node ≥ 20", "pnpm 11", "Foundry (forge)", "a Base Sepolia key"]} />
        <CodeBlock
          lang="bash"
          code={`# from the repo root
$ pnpm install
$ pnpm --filter @steamlink/contracts setup   # forge install deps
$ forge --version                              # confirm Foundry is on PATH`}
        />
      </Section>

      {/* ── 1 ── */}
      <Section id="c-fork">
        <Step n={1} title="Fork & branch" />
        <P>
          Fork the repo on GitHub, clone your fork, and cut a feature branch. Use a descriptive,
          kebab-case branch name.
        </P>
        <CodeBlock
          lang="bash"
          code={`$ git clone https://github.com/<you>/SteamLink.git
$ cd SteamLink
$ git remote add upstream ${REPO}.git
$ git checkout -b feat/checkers-game`}
        />
      </Section>

      {/* ── 2 ── */}
      <Section id="c-define">
        <Step n={2} title="Define the game" />
        <P>
          Create <C>web/lib/&lt;game&gt;/game.ts</C> and describe the onchain state as tables and the
          logic as Solidity system paths. The name must be lower-kebab/snake.
        </P>
        <CodeBlock
          title="web/lib/checkers/game.ts"
          code={`import { defineGame, t } from "@steamlink/core";

export const checkers = defineGame({
  name: "checkers",
  tables: {
    Board:     { roomId: t.uint256, squares: t.bytes, turn: t.address },
    Player:    { id: t.address, roomId: t.uint256, color: t.uint8 },
    TurnOrder: { roomId: t.uint256, current: t.address },
  },
  systems: {
    MoveSystem:    "./systems/Move.sol",
    CaptureSystem: "./systems/Capture.sol",
  },
  economy: {
    entryFee: { amount: "1", token: "USDC" },
    pot:      { type: "winner-take-all", rake: "0.02" },
  },
});`}
        />
        <Callout tone="warn">
          Read the entry-fee / pot token from relayer capabilities at runtime — the <C>economy</C>{" "}
          block declares <em>amounts</em>, never a hardcoded token address.
        </Callout>
      </Section>

      {/* ── 3 ── */}
      <Section id="c-systems">
        <Step n={3} title="Write the systems" />
        <P>
          Game logic lives in Solidity, never JS. Each system in your <C>defineGame</C> maps to a
          contract that reads/writes the generated tables. Put them in{" "}
          <C>packages/contracts/src/systems/</C> and test them with Foundry.
        </P>
        <CodeBlock
          lang="sol"
          title="packages/contracts/src/systems/Move.sol"
          code={`// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { Board, TurnOrder } from "../codegen/Tables.sol";

contract MoveSystem {
    /// @dev Enforcers already guarantee it's msg.sender's turn before this runs.
    function move(uint256 roomId, uint8 from, uint8 to) external {
        bytes memory squares = Board.getSquares(roomId);
        require(_legal(squares, from, to), "illegal move");
        // ... mutate squares, advance TurnOrder ...
        Board.setSquares(roomId, squares);
        TurnOrder.setCurrent(roomId, _next(roomId));
    }
}`}
        />
        <CodeBlock
          lang="bash"
          code={`$ forge test --match-contract MoveSystem -vvv`}
        />
        <Callout tone="note" title="Don't reinvent enforcement">
          Turn order and spend caps are enforced by the shared caveat enforcers, not your system.
          Your system can assume the engine already rejected out-of-turn or over-budget calls.
        </Callout>
      </Section>

      {/* ── 4 ── */}
      <Section id="c-deploy">
        <Step n={4} title="Deploy to Base Sepolia" />
        <P>
          Generate the Solidity tables from your schema, deploy the World + systems, and drop the
          resulting addresses into <C>web/lib/&lt;game&gt;/deployments/base-sepolia.json</C> (mirror
          how UNO and Monopoly do it).
        </P>
        <CodeBlock
          lang="bash"
          code={`# from packages/contracts
$ forge script script/Deploy.s.sol \\
    --rpc-url $BASE_SEPOLIA_RPC \\
    --private-key $DEPLOYER_KEY \\
    --broadcast`}
        />
        <CodeBlock
          lang="json"
          title="web/lib/checkers/deployments/base-sepolia.json"
          code={`{
  "world": "0x...",
  "systems": { "MoveSystem": "0x...", "CaptureSystem": "0x..." },
  "delegationManager": "0x...",
  "usdc": "0x036CbD53842c5426634e7929541eC2318f3dCF7e"
}`}
        />
        <Callout tone="warn" title="Never commit funded keys">
          Deployer and player keys, and any <C>.env.local</C>, are gitignored
          (<C>**/players.*.local.json</C>, <C>web/.env.local</C>). Keep it that way — a committed
          funded key is an automatic PR rejection.
        </Callout>
      </Section>

      {/* ── 5 ── */}
      <Section id="c-backend">
        <Step n={5} title="Wire the backend" />
        <P>
          Add namespaced route handlers under <C>web/app/api/&lt;game&gt;/</C> and an{" "}
          <C>auto-start.ts</C> that seats bots so a visitor can play immediately. Boot it from{" "}
          <C>web/instrumentation.ts</C> alongside the existing games — gated on the Node runtime.
        </P>
        <CodeBlock
          title="web/instrumentation.ts"
          code={`export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    await import("./lib/uno/auto-start");
    await import("./lib/monopoly/auto-start");
    await import("./lib/checkers/auto-start"); // ← your game
  }
}`}
        />
        <Callout tone="rule" title="Capabilities are the source of truth">
          Read payment/fee tokens and the relayer <C>targetAddress</C> from{" "}
          <C>relayer_getCapabilities</C> and cache them. Reject a <C>targetAddress</C> mismatch before
          submitting a bundle. Webhooks drive status — no chain polling on the hot path.
        </Callout>
      </Section>

      {/* ── 6 ── */}
      <Section id="c-route">
        <Step n={6} title="Add the route & UI" />
        <P>
          Create <C>web/app/play/&lt;game&gt;/page.tsx</C>. Use the shared wallet via{" "}
          <C>useWallet()</C> — never spin up your own connector — and render every transaction hash
          with <C>linkifyTx</C> so it links to the explorer. Match the paper/sticker design language.
        </P>
        <CodeBlock
          lang="tsx"
          title="web/app/play/checkers/page.tsx"
          code={`"use client";
import { useWallet } from "@/components/wallet/WalletProvider";
import { linkifyTx } from "@/components/linkifyTx";

export default function CheckersPage() {
  const { connection, grant, connect } = useWallet();
  // ... call /api/checkers/* with the shared connection ...
  // render logs with {linkifyTx(line, "tx-link")}
}`}
        />
        <Callout tone="tip">
          Give your game its own accent from the candy palette (<C>coral</C>, <C>grape</C>,{" "}
          <C>sky</C>, <C>grass</C>, <C>amber</C>, <C>berry</C>) and reuse the <C>sticker</C> /{" "}
          <C>sticker-lift</C> utilities for tactile, on-brand UI.
        </Callout>
      </Section>

      {/* ── 7 ── */}
      <Section id="c-catalog">
        <Step n={7} title="Register in the catalog" />
        <P>
          Add a <C>GameEntry</C> to <C>GAMES</C> in <C>web/lib/games.ts</C>. Set <C>status: "live"</C>{" "}
          so the card routes to <C>/play/&lt;slug&gt;</C>. Porting a game is a registry edit, not a
          page rewrite.
        </P>
        <CodeBlock
          title="web/lib/games.ts"
          code={`{
  slug: "checkers",
  title: "Checkers",
  monogram: "CK",
  tagline: "Kings, captures, and a real USDC pot.",
  description:
    "The full draughts ruleset on Base. Every move is gasless; the 1 USDC entry is a real x402 payment. Last player standing takes the pot.",
  status: "live",
  players: "2",
  tags: ["Board", "Gasless", "x402 entry"],
  accent: "grass",
}`}
        />
      </Section>

      {/* ── 8 ── */}
      <Section id="c-test">
        <Step n={8} title="Build & test" />
        <P>
          Everything must build and pass before you open the PR. Solidity is tested with Foundry,
          TypeScript with vitest, and the mono-app with a production build.
        </P>
        <CodeBlock
          lang="bash"
          code={`# contracts
$ forge test
# typescript packages
$ pnpm -r test
# the web mono-app actually compiles
$ pnpm --filter @steamlink/web build`}
        />
        <Callout tone="warn" title="Verify, don't assume">
          Run these and read the output. &ldquo;It should work&rdquo; is not evidence — a green{" "}
          <C>build</C> and passing tests are.
        </Callout>
      </Section>

      {/* ── 9 ── */}
      <Section id="c-pr">
        <Step n={9} title="Open the PR" />
        <P>
          Commit in logical batches with clear messages, push your branch, and open a PR against{" "}
          <C>main</C>. Describe the game, link the deployed contract addresses, and attach a short
          clip of a full round if you can.
        </P>
        <CodeBlock
          lang="bash"
          code={`$ git add web/lib/checkers web/app/play/checkers web/app/api/checkers \\
        packages/contracts/src/systems web/lib/games.ts
$ git commit -m "feat(checkers): add Checkers game (in-tree, gasless on Base)"
$ git push origin feat/checkers-game

# then, with the GitHub CLI:
$ gh pr create --base main --title "feat: add Checkers" \\
    --body "New in-tree game. Deployed to Base Sepolia. One delegation, gasless moves, x402 entry."`}
        />
        <P>
          Or open it from the compare view:{" "}
          <a
            href={`${REPO}/compare`}
            target="_blank"
            rel="noreferrer"
            className="font-bold text-coral-deep underline"
          >
            {REPO.replace("https://", "")}/compare
          </a>
          .
        </P>
      </Section>

      {/* checklist */}
      <Section id="c-checklist">
        <H2>PR checklist</H2>
        <P>Reviewers will look for all of these. Tick them off before requesting review:</P>
        <Ul>
          <Li>
            <strong>One delegation.</strong> No wallet re-prompt mid-game — moves and charges redeem
            the single grant.
          </Li>
          <Li>
            <strong>Base only.</strong> <C>chain</C> stays <C>"base"</C>; no multi-chain abstraction
            added.
          </Li>
          <Li>
            <strong>No hardcoded tokens.</strong> Payment/fee token and <C>targetAddress</C> come from
            capabilities.
          </Li>
          <Li>
            <strong>No secrets committed.</strong> Funded keys / <C>.env.local</C> stay gitignored.
          </Li>
          <Li>
            <strong>Typed errors.</strong> Enforcer rejections surface as <C>NexusError</C> codes, not
            raw strings.
          </Li>
          <Li>
            <strong>Explorer links.</strong> Every tx hash renders through <C>linkifyTx</C>.
          </Li>
          <Li>
            <strong>Green checks.</strong> <C>forge test</C>, <C>pnpm -r test</C>, and the web build
            all pass.
          </Li>
          <Li>
            <strong>On-brand UI.</strong> Uses the shared wallet provider and the paper/sticker design
            language.
          </Li>
        </Ul>
        <Callout tone="tip" title="That's it">
          A merged game shows up on the home shelf, gasless from the first move. Welcome to the
          library.
        </Callout>
      </Section>
    </>
  );
}
