import { CodeBlock } from "./CodeBlock";
import { Section, PageTitle, H2, H3, P, Lead, C, Callout, Method, Pills, Ul, Li } from "./prose";
import type { NavGroup } from "./DocsShell";

export const SDK_NAV: NavGroup[] = [
  {
    group: "Getting started",
    items: [
      { id: "sdk-overview", label: "Overview" },
      { id: "sdk-install", label: "Install" },
      { id: "sdk-client", label: "Client setup" },
    ],
  },
  {
    group: "@steamlink/core",
    items: [
      { id: "core-definegame", label: "defineGame()" },
      { id: "core-t", label: "The t schema DSL" },
      { id: "core-manifest", label: "Manifest & codegen" },
      { id: "core-delegation", label: "Delegation engine" },
      { id: "core-gameplay", label: "Moves & queries" },
      { id: "core-randomness", label: "Randomness" },
    ],
  },
  {
    group: "@steamlink/relayer",
    items: [
      { id: "relayer-adapters", label: "Adapters" },
      { id: "relayer-capabilities", label: "Capabilities" },
      { id: "relayer-webhooks", label: "Webhooks" },
    ],
  },
  {
    group: "@steamlink/secrets",
    items: [
      { id: "secrets-seal", label: "seal()" },
      { id: "secrets-reveal", label: "reveal()" },
      { id: "secrets-verify", label: "verify()" },
      { id: "secrets-policies", label: "Policies & adapters" },
    ],
  },
  {
    group: "@steamlink/types",
    items: [{ id: "types-errors", label: "Errors & codes" }],
  },
];

export function SdkDocs() {
  return (
    <>
      <Section id="sdk-overview">
        <PageTitle kicker="SDK Reference">The Steamlink SDK</PageTitle>
        <Lead>
          A fully onchain, turn-based game engine for <strong>Base</strong>. A player signs{" "}
          <strong>one</strong> ERC-7710 delegation when they join a room; the engine redeems that
          single signature for everything after — gasless moves (no wallet popups) and x402 payments
          bounded by on-chain spend caps.
        </Lead>
        <P>
          You describe a game as <strong>data</strong> (tables — the onchain state schema) and{" "}
          <strong>logic</strong> (systems — Solidity sources). The SDK handles cryptography, relaying,
          and settlement. The packages:
        </P>
        <Pills
          items={[
            "@steamlink/core",
            "@steamlink/relayer",
            "@steamlink/secrets",
            "@steamlink/types",
          ]}
        />
        <Callout tone="rule" title="Base only">
          <C>chain</C> is strictly <C>"base"</C>. The budget token is USDC (6 decimals). There is no
          multi-chain abstraction — read the payment token and relayer <C>targetAddress</C> from{" "}
          <C>relayer_getCapabilities</C> and cache them; never hardcode a token.
        </Callout>
      </Section>

      <Section id="sdk-install">
        <H2>Install</H2>
        <P>
          Install <C>@steamlink/core</C>. It pulls in <C>@steamlink/types</C> (the shared{" "}
          <C>NexusError</C> / error-code surface and branded <C>Address</C>/<C>Hex</C> types), which
          core re-exports for convenience. Add the relayer and secrets packages as you need them.
        </P>
        <CodeBlock
          lang="bash"
          code={`# core SDK + shared types
$ npm install @steamlink/core

# optional: relayer adapter and sealed-state layer
$ npm install @steamlink/relayer @steamlink/secrets`}
        />
        <P>
          Everything is typed end to end: the <C>defineGame</C> schema generates both the Solidity
          table glue and the TypeScript client types, so a misspelled table fails at compile time.
        </P>
      </Section>

      <Section id="sdk-client">
        <H2>Client setup</H2>
        <P>
          <C>createNexusClient</C> resolves the relayer&apos;s capabilities once (
          <C>relayer_getCapabilities</C>) and caches the accepted tokens, the fee collector, and the{" "}
          <C>targetAddress</C> to use as the delegation <C>to</C>.
        </P>
        <CodeBlock
          code={`import { createNexusClient } from "@steamlink/core";

const nexus = await createNexusClient({
  chain: "base",                       // strict — Base only
  world: "0xWorldContractAddress",
  relayer: {
    provider: "1shot",
    endpoint: "https://relayer.1shotapi.com",
    webhookUrl: "https://yourapp.com/nexus/webhook", // push status, no polling
  },
  secrets: { provider: "lit", network: "datil" },
  signer,                              // viem account / MetaMask provider
});`}
        />
        <Callout tone="note" title="Webhooks drive the hot path">
          Status comes from relayer webhooks → an internal <C>StatusEvent</C>. Chain polling is a
          silent fallback only when no <C>webhookUrl</C> is set.
        </Callout>
      </Section>

      {/* ───────────────────────── @steamlink/core ───────────────────────── */}

      <Section id="core-definegame">
        <PageTitle kicker="@steamlink/core">Define a game</PageTitle>
        <Method signature="defineGame(def) → GameDefinition" pkg="@steamlink/core">
          The single source of truth for a game. <C>tables</C> is the onchain state schema,{" "}
          <C>systems</C> maps a system name to its Solidity source path, and <C>economy</C> configures
          monetization. Validates eagerly: the name must be lower-kebab/snake, there must be at least
          one table, each table needs fields, and <C>pot.rake</C> must be a fraction in <C>[0, 1)</C>.
        </Method>
        <CodeBlock
          code={`import { defineGame, t } from "@steamlink/core";

export const uno = defineGame({
  name: "uno",

  // ── tables (onchain schema) ──
  tables: {
    Player:      { id: t.address, roomId: t.uint256, isReady: t.bool },
    Hand:        { player: t.address, commitment: t.bytes32, count: t.uint8 }, // sealed
    DiscardPile: { roomId: t.uint256, topCard: t.uint8, activeColor: t.uint8 },
    TurnOrder:   { roomId: t.uint256, current: t.address, direction: t.int8 },
  },

  // ── systems (logic lives in Solidity, never JS) ──
  systems: {
    PlayCardSystem: "./systems/PlayCard.sol",
    DrawSystem:     "./systems/Draw.sol",
    CallUnoSystem:  "./systems/CallUno.sol",
  },

  // ── monetization hooks ──
  economy: {
    entryFee: { amount: "5", token: "USDC" },
    pot:      { type: "winner-take-all", rake: "0.02" },
  },
});`}
        />
        <P>From that one object the engine derives:</P>
        <Ul>
          <Li>Solidity table definitions + a deploy manifest (consumed by the CLI).</Li>
          <Li>
            A typed client — <C>uno.move</C>, <C>uno.query</C>, <C>uno.charge</C>,{" "}
            <C>uno.subscribe</C>.
          </Li>
          <Li>
            React hooks (<C>useTable</C>, <C>useTurn</C>, …) when <C>@steamlink/react</C> is present.
          </Li>
        </Ul>
      </Section>

      <Section id="core-t">
        <H2>The t schema DSL</H2>
        <P>
          <C>t</C> is the field-type DSL used to declare table columns. Each field maps to a Solidity
          type and a JS type, so codegen and the client stay in lockstep.
        </P>
        <CodeBlock
          code={`import { t } from "@steamlink/core";

// scalar field kinds
t.address    // address  → \`0x\${string}\`
t.bool       // bool     → boolean
t.uint8      // uint8    → number
t.uint256    // uint256  → bigint
t.int8       // int8     → number
t.bytes      // bytes    → \`0x\${string}\`
t.bytes32    // bytes32  → \`0x\${string}\`

// a table is just a record of fields
const Score = { player: t.address, wins: t.uint32 };`}
        />
        <Callout tone="tip">
          Tables and systems are referenced by name everywhere — the client, codegen, and React hooks
          all bind to the same names. A typo is a <strong>compile-time</strong> error, not a runtime
          one.
        </Callout>
      </Section>

      <Section id="core-manifest">
        <H2>Manifest &amp; codegen</H2>
        <Method signature="buildManifest(game) → DeployManifest" pkg="@steamlink/core">
          Deterministic codegen: the same schema produces the same table/system ids every time. The
          manifest is the JSON the CLI deploys.
        </Method>
        <Method signature="generateSolidityTables(manifest) → string" pkg="@steamlink/core">
          Emits the Solidity tables library committed to <C>src/</C> and compiled by Foundry.
        </Method>
        <Method signature="resourceId(type, name) → Hex" pkg="@steamlink/core">
          The canonical on-chain resource id for a table or system, derived from its name.
        </Method>
        <CodeBlock
          code={`import { buildManifest, generateSolidityTables } from "@steamlink/core";

const manifest = buildManifest(uno);              // JSON the CLI deploys
const solidity = generateSolidityTables(manifest); // → src/codegen/Tables.sol`}
        />
      </Section>

      <Section id="core-delegation">
        <H2>Delegation engine</H2>
        <P>
          The heart of Steamlink. One ERC-7715 grant at <C>joinRoom()</C> carries both the{" "}
          <strong>gameplay</strong> and <strong>budget</strong> caveat groups. The engine compiles
          those into concrete on-chain caveats, signs the delegation (EIP-712), and builds the
          redeem/move/charge calldata the relayer submits.
        </P>
        <Method signature="buildGameplayCaveats(cfg) → Caveat[]" pkg="@steamlink/core">
          The gameplay caveat group: which systems are callable, turn-bound, expiry.
        </Method>
        <Method signature="buildBudgetCaveats(cfg) → Caveat[]" pkg="@steamlink/core">
          The budget caveat group: token, total cap, per-action cap, allowed recipients.
        </Method>
        <Method signature="signDelegation(delegation, signer) → SignedDelegation" pkg="@steamlink/core">
          Signs the unsigned delegation over the EIP-712 domain. Supports ECDSA EOAs and ERC-1271
          smart accounts.
        </Method>
        <Method signature="buildMoveExecution(args) · buildChargeExecution(args)" pkg="@steamlink/core">
          Encode a system call or an x402 charge into an <C>Execution</C> the relayer redeems against
          the signed delegation.
        </Method>
        <Method signature="usdcToWei(amount) → bigint" pkg="@steamlink/core">
          Convert a human USDC string (e.g. <C>"5.00"</C>) to 6-decimal base units.
        </Method>
        <CodeBlock
          code={`import {
  buildGameplayCaveats,
  buildBudgetCaveats,
  signDelegation,
  usdcToWei,
} from "@steamlink/core";

const gameplay = buildGameplayCaveats({
  allowedSystems: ["PlayCardSystem", "DrawSystem", "CallUnoSystem"],
  turnBound: true,
  expiresAt: Date.now() + 3 * 3_600_000,
});

const budget = buildBudgetCaveats({
  token: USDC,                       // from relayer capabilities — never hardcode
  totalCap: usdcToWei("5"),
  perActionCap: usdcToWei("5"),
  allowedRecipients: [potAddress],
});

const signed = await signDelegation(
  { caveats: [...gameplay, ...budget], /* delegator, delegate, authority */ },
  signer,
);`}
        />
        <Callout tone="rule" title="One delegation per player per room">
          A single grant carries both caveat groups. No flow may re-prompt the wallet mid-game.
          Enforcer rejections surface as typed <C>NexusError</C>s (e.g. <C>NOT_YOUR_TURN</C>,{" "}
          <C>BUDGET_EXCEEDED</C>).
        </Callout>
      </Section>

      <Section id="core-gameplay">
        <H2>Moves, queries &amp; charges</H2>
        <Method signature="game.move(system, args) → Promise<Receipt>" pkg="client">
          Redeems the gameplay caveats, encodes the system call, submits the bundle to the relayer
          (gas in USDC), and resolves when the webhook reports terminal status. The on-chain
          enforcers reject out-of-turn or disallowed-system calls.
        </Method>
        <CodeBlock
          code={`await uno.move("PlayCardSystem", {
  cardId: 42,
  colorChoice: Color.Red,   // for wilds
  proof: handProof,         // Merkle proof the card was in your sealed hand
});`}
        />
        <Method signature="game.query(table, key) → Promise<Row>" pkg="client">
          Read current table state by primary key.
        </Method>
        <Method signature="game.subscribe(table, key, cb) → Unsubscribe" pkg="client">
          Real-time updates driven by relayer webhooks → indexer events → WebSocket push. No polling.
        </Method>
        <CodeBlock
          code={`const hand = await uno.query("Hand", { player: account.address });

const unsub = uno.subscribe("TurnOrder", { roomId }, (turn) => {
  if (turn.current === account.address) promptPlayer();
});`}
        />
        <Method signature="game.charge({ amount, to, reason }) → Promise<Receipt>" pkg="client">
          An x402 payment that redeems the <strong>budget</strong> caveats of the same delegation —
          no second signature. Bounded on-chain by the per-action and total spend caps.
        </Method>
        <CodeBlock
          code={`await uno.charge({ amount: "5", to: potAddress, reason: "tournament entry" });`}
        />
      </Section>

      <Section id="core-randomness">
        <H2>Randomness</H2>
        <P>
          Provable fairness via Chainlink VRF, with a commit-reveal fast path. The facade picks a tier
          per call.
        </P>
        <Method signature="random(opts) · dice(sides, n)" pkg="@steamlink/core">
          Request randomness. <C>dice</C> is a convenience wrapper for board games.
        </Method>
        <Method signature="commitRevealCommit() · commitRevealReveal()" pkg="@steamlink/core">
          The two halves of the commit-reveal scheme; <C>commitmentFor</C> derives the commitment hash.
        </Method>
        <CodeBlock
          code={`import { dice, commitRevealCommit, commitRevealReveal } from "@steamlink/core";

const roll = await dice(6, 2);            // 2d6, VRF-backed
const commit = commitRevealCommit(seed);  // publish commit, reveal next turn`}
        />
      </Section>

      {/* ───────────────────────── @steamlink/relayer ───────────────────────── */}

      <Section id="relayer-adapters">
        <PageTitle kicker="@steamlink/relayer">Relayer adapters</PageTitle>
        <P>
          Everything is an adapter behind a TypeScript port. The relayer submits bundles, pays gas in
          stablecoins, and (for EOAs) bundles EIP-7702 upgrades. Game code never touches a concrete
          provider — it talks to the <C>RelayerAdapter</C> port.
        </P>
        <Method signature="new OneShotRelayer(config) → RelayerAdapter" pkg="@steamlink/relayer">
          The default 1Shot Permissionless Relayer adapter (gas paid in USDC, EIP-7702 EOA upgrades).
        </Method>
        <Method signature="new DirectRelayer(config) → RelayerAdapter" pkg="@steamlink/relayer">
          A direct-submission adapter for local dev / self-relaying. <C>revertDataOf</C> extracts the
          revert reason from a failed call.
        </Method>
        <CodeBlock
          code={`import { OneShotRelayer } from "@steamlink/relayer";

const relayer = new OneShotRelayer({
  endpoint: "https://relayer.1shotapi.com",
  apiKey: process.env.ONESHOT_API_KEY!,   // backend only — never the browser
  webhookUrl: "https://yourapp.com/nexus/webhook",
});`}
        />
        <Callout tone="warn" title="Least privilege">
          Relayer and Lit credentials live only on the backend. The browser never sees them.
        </Callout>
      </Section>

      <Section id="relayer-capabilities">
        <H2>Capabilities</H2>
        <Method signature="relayer.getCapabilities() → RelayerCapabilities" pkg="@steamlink/relayer">
          Returns accepted payment/fee tokens and the relayer <C>targetAddress</C>. Cache these.{" "}
          <strong>Reject a <C>targetAddress</C> mismatch before submitting a bundle.</strong>
        </Method>
        <CodeBlock
          code={`const caps = await relayer.getCapabilities();
// caps.feeTokens, caps.targetAddress — the delegation \`to\`
if (bundle.to !== caps.targetAddress) throw new Error("targetAddress mismatch");`}
        />
      </Section>

      <Section id="relayer-webhooks">
        <H2>Webhooks</H2>
        <Method signature="signWebhook(payload, secret) · relayer status events" pkg="@steamlink/relayer">
          The relayer pushes <C>OneShotWebhookPayload</C>s; verify the signature, map to an internal{" "}
          <C>StatusEvent</C>, and reconcile optimistic UI. Polling is a silent fallback only.
        </Method>
        <CodeBlock
          code={`import { signWebhook } from "@steamlink/relayer";

// in your webhook handler
const expected = signWebhook(rawBody, process.env.ONESHOT_WEBHOOK_SECRET!);
if (expected !== headers["x-signature"]) return res.status(401).end();
// → emit StatusEvent, resolve the pending move/charge`}
        />
      </Section>

      {/* ───────────────────────── @steamlink/secrets ───────────────────────── */}

      <Section id="secrets-seal">
        <PageTitle kicker="@steamlink/secrets">Sealed secret state</PageTitle>
        <P>
          Hidden information (a hand of cards, a hidden bid) is sealed with Lit Protocol so only the
          owner can read it, while the chain holds a commitment. Configure a default adapter once on
          the backend, then use the thin wrappers.
        </P>
        <Method signature="seal(data, { conditions | policy }) → Sealed" pkg="@steamlink/secrets">
          Seal bytes behind explicit access <C>conditions</C> or a named <C>policy</C> (expanded via
          the policy registry).
        </Method>
        <CodeBlock
          code={`import { seal, setDefaultSecretsAdapter, LitSecrets } from "@steamlink/secrets";

setDefaultSecretsAdapter(new LitSecrets({ network: "datil" })); // once, on the backend

const sealedHand = await seal(handBytes, {
  policy: "owner-only",
  context: { owner: player.address },
});
// store sealedHand off-chain; put its commitment in the Hand table`}
        />
      </Section>

      <Section id="secrets-reveal">
        <H2>reveal()</H2>
        <Method signature="reveal(sealed, auth) → Bytes" pkg="@steamlink/secrets">
          Conditionally decrypt a sealed blob. Lit checks the access conditions against the caller&apos;s{" "}
          <C>AuthContext</C> before releasing the key shares.
        </Method>
        <CodeBlock code={`const handBytes = await reveal(sealedHand, { authSig });`} />
      </Section>

      <Section id="secrets-verify">
        <H2>verify()</H2>
        <Method signature="verify(sealed, claim) → Attestation" pkg="@steamlink/secrets">
          Prove a move is legal <strong>without</strong> fully revealing the secret. Returns a signed{" "}
          <C>Attestation</C> the on-chain verifier checks — e.g. &ldquo;this card really was in my
          sealed hand&rdquo;.
        </Method>
        <CodeBlock
          code={`import { verify, isLegalMove } from "@steamlink/secrets";

const attestation = await verify(sealedHand, {
  move: { cardId: 42 },
  rule: isLegalMove,           // shared with the on-chain verifier
});
// pass attestation alongside the move; the chain validates it`}
        />
      </Section>

      <Section id="secrets-policies">
        <H2>Policies &amp; adapters</H2>
        <Method signature="LitSecrets · LocalSecrets" pkg="@steamlink/secrets">
          <C>LitSecrets</C> is the default Lit-backed adapter (network-gated). <C>LocalSecrets</C> is a
          real offline AES-256-GCM adapter for dev &amp; tests — same port, no network.
        </Method>
        <Method signature="defaultPolicyRegistry · defineAccessCondition · BUILTIN_POLICIES" pkg="@steamlink/secrets">
          Named-policy registry plus built-in templates, so access conditions are declared once and
          reused by name.
        </Method>
        <CodeBlock
          code={`import { LocalSecrets, setDefaultSecretsAdapter } from "@steamlink/secrets";

// tests / local dev — no Lit network needed
setDefaultSecretsAdapter(new LocalSecrets());`}
        />
      </Section>

      {/* ───────────────────────── @steamlink/types ───────────────────────── */}

      <Section id="types-errors">
        <PageTitle kicker="@steamlink/types">Errors &amp; codes</PageTitle>
        <P>
          Every failure surfaces as a typed <C>NexusError</C> with a stable <C>NexusErrorCode</C>.
          Apply optimistic updates, reconcile on webhook, and branch on the code — never parse a
          message string.
        </P>
        <Method signature="class NexusError extends Error { code: NexusErrorCode }" pkg="@steamlink/types">
          Thrown by the client and re-exported from <C>@steamlink/core</C>. Common codes:{" "}
          <C>NOT_YOUR_TURN</C>, <C>BUDGET_EXCEEDED</C>, <C>INVALID_CONFIG</C>,{" "}
          <C>SYSTEM_NOT_ALLOWED</C>.
        </Method>
        <CodeBlock
          code={`import { NexusError } from "@steamlink/core"; // re-exported from @steamlink/types

try {
  await uno.move("PlayCardSystem", { cardId: 42 });
} catch (e) {
  if (e instanceof NexusError && e.code === "NOT_YOUR_TURN") {
    toast("Hold on — it's not your turn yet.");
  } else {
    throw e;
  }
}`}
        />
        <Callout tone="note" title="Branded types">
          <C>@steamlink/types</C> also exports branded <C>Address</C> / <C>Hex</C> types and the
          strict <C>chain</C> union, so an unchecked hex string won&apos;t slip into an address slot.
        </Callout>
      </Section>
    </>
  );
}
