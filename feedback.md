# Infrastructure Feedback — ERC-7710 · x402 · 1Shot

> Constructive integration feedback from building **SteamLink / Nexus** (a gasless,
> fully-onchain game engine on Base) on top of these three pieces of infrastructure.
> Structured with the **SBI model** (Situation → Behavior → Impact) and the
> **Preparation → Delivery → Follow-up** framework (see
> `.agents/skills/feedback-mastery`). The intent is collaborative: facts and
> observable behavior, not blame — each item ends with a suggested action.

## Preparation — context & goals

- **Who's giving this:** an integrator who shipped a real, on-chain implementation
  of all three (custom `NexusDelegationManager`, x402 budget charges, and a
  spec-faithful 1Shot public-relayer adapter), with passing contract + live tests.
- **Goal:** make the next integrator's path smoother — reduce the time-to-working
  and the foot-guns we hit, without re-litigating design we ultimately worked with.
- **Scope:** developer-experience and protocol-surface feedback on the *infra*, not
  on any person or team.

---

## 1. ERC-7710 (delegation framework)

### 1.1 Smart-account signing path is under-documented

- **Situation:** We needed the player's single delegation to be signable by a
  **smart account** (ERC-1271), not just an EOA, for the MetaMask rail.
- **Behavior:** MetaMask's signature controller **blocks `eth_signTypedData`** when
  `primaryType` is `"Delegation"` and `message.delegator` is one of the user's own
  internal accounts ("External signature requests cannot sign delegations for
  internal accounts"). The working path was to derive a **Hybrid DeleGator smart
  account** (its own contract address ⇒ not "internal") and verify on-chain via OZ
  `SignatureChecker.isValidSignatureNow` (ECDSA + ERC-1271).
- **Impact:** Real engineering cost to discover and work around: the smart account
  must be **deployed before signing** for the 1271 path, and **counterfactual /
  ERC-6492** signatures silently fail (undeployed ⇒ `code.length == 0` ⇒ the ECDSA
  branch ⇒ `InvalidSignature`). This is a quiet failure mode, not a clear error.
- **Suggested action:** Document the internal-account block prominently in the
  delegation docs; ship a first-class "sign with a smart account" example; and make
  redemption either 6492-aware or emit a typed "account not deployed" error instead
  of a generic signature failure.

### 1.2 Custom vs. canonical DelegationManager are not interoperable

- **Situation:** We run our **own** `NexusDelegationManager` (own EIP-712 domain,
  `"Nexus Game Delegation"`) rather than MetaMask's canonical manager.
- **Behavior:** The two managers use **different `Delegation` structs** (ours carries
  `maxRedemptions`; the canonical one does not) and **different EIP-712 domains**, so
  a signature produced for one **cannot be redeemed by the other**. A relayer keyed
  to the canonical `targetAddress` (e.g. 1Shot) cannot redeem our delegations, and
  vice-versa.
- **Impact:** Forces an **either/or** with a single signature: gasless via our
  manager + a funded key, **or** canonical-manager + a permissionless relayer — not
  both. Cross-rail portability requires re-signing.
- **Suggested action:** A minimal, **standard ERC-7710 `Delegation` struct + domain**
  that both custom and canonical managers accept (replay policy delegated to caveats)
  would unlock relayer portability without giving up a custom manager.

### 1.3 "Stateless router" default is fragile for real money

- **Situation:** The manager appends `delegator` as the ERC-2771 trailing sender and
  is the World's **trusted forwarder**.
- **Behavior:** Target/calldata are **not constrained at the manager** — safety rests
  entirely on the signed caveat set. A delegation signed with the wrong or empty
  caveats is effectively a **signed spoofing primitive**. (We hardened ours to
  deny-by-default: reject caveat-less / zero-enforcer delegations.)
- **Impact:** The pure-router posture means one mis-scoped caveat set is an exploit,
  and the failure is silent (it just executes).
- **Suggested action:** ERC-7710 reference managers should ship a **deny-by-default**
  example (require ≥1 caveat, optionally a manager-level target allowlist) so the
  insecure case isn't the path of least resistance.

---

## 2. x402 (delegated stablecoin payments)

### 2.1 The protocol doesn't bind the payer — the integrator must

- **Situation:** Entry fees and in-game charges settle as x402 payments redeemed
  from the player's **budget** delegation: `USDC.transferFrom(player → pot)` executed
  by the manager.
- **Behavior:** The transfer's **`from` field is attacker/relayer-controlled** unless
  a caveat pins it. Nothing in the x402-over-delegation pattern itself binds the payer
  to the delegator; our budget enforcers initially decoded only `amount`/`to` and left
  `from` unconstrained.
- **Impact:** Without an explicit pin, **any account that had approved the manager
  could be drained** while redeeming a *different* player's delegation, charged
  against that delegation's cap. We closed this by enforcing `from == delegator`.
- **Suggested action:** x402 facilitator/middleware guidance should **mandate
  payer-binding** (`from == delegator`, or a payer-bound authorization) for any
  `transferFrom`-style settlement, and call it out as a required check.

### 2.2 Verification is bespoke per integrator

- **Situation:** We verify x402 settlement on the mined webhook.
- **Behavior:** Verification is hand-rolled: **receipt reading + nonce replay
  protection + finality depth** in our own facilitator. The 402-challenge → redeem →
  verify loop has no shared reference implementation, and payment/fee tokens +
  `targetAddress` must be read **live from capabilities and cached** (hardcoding is a
  foot-gun we explicitly guard against).
- **Impact:** Every integrator re-implements settlement verification, and each one is
  a place to get finality or replay wrong.
- **Suggested action:** A **reference x402 facilitator** that reads capabilities,
  enforces the `targetAddress` match, and bakes in replay + finality would cut
  duplicated, security-sensitive work.

---

## 3. 1Shot (Permissionless Public Relayer)

### 3.1 The documented spec location doesn't resolve

- **Situation:** Integrating the 1Shot public relayer, we started from the provided
  docs URL (`1shotapi.com/docs/skills`).
- **Behavior:** That page is a **navigation index, not the spec**. The
  `api-reference/public-relayer` page only says "Loading OpenRPC spec…"; the
  documented source `…/openrpc/openrpc.json` **404s on the relayer host**, and the
  testnet host (`relayer.1shotapi.dev/openrpc/openrpc.json`) **404s** too. The
  authoritative OpenRPC 1.4.1 spec actually lives at `1shotapi.com/openrpc/openrpc.json`.
- **Impact:** It took several probes (including trying `rpc.discover`, which the
  endpoint rejects) to locate the real spec. A docs-following integrator stalls here.
- **Suggested action:** Serve the OpenRPC spec at a **stable, documented URL on the
  relayer host**, link it directly from the API-reference page, and support
  `rpc.discover` for programmatic discovery.

### 3.2 Public capabilities are empty for the target chains

- **Situation:** We read capabilities for Base mainnet and Base Sepolia.
- **Behavior:** `relayer_getCapabilities(["8453"])` and `(["84532"])` both return
  **`{}`** on the public `.com` host, and `relayer_getFeeData({chainId:"84532", …})`
  returns **"Chain undefined is not supported"** (the error suggests the param wasn't
  read from the OpenRPC content-descriptor shape we sent).
- **Impact:** The public relayer **cannot actually settle** our chains without some
  backend registration/onboarding that isn't documented. Our adapter is correct by
  the spec but inert until a relayer instance serves the chain — we added a boot-time
  capability guard so this surfaces loudly instead of as a silent revert.
- **Suggested action:** Document the **onboarding required** for a chain/relayer to
  return non-empty capabilities, and align `relayer_getFeeData`'s parameter parsing
  with the published content descriptor so a spec-conformant call isn't rejected.

### 3.3 7710 redemption is bound to the relayer's own manager

- **Situation:** We mapped our redemptions onto `relayer_send7710Transaction`.
- **Behavior:** The relayer redeems against **its own `targetAddress`** (the canonical
  DelegationManager). Our delegations are signed `delegate = our funded relayer`
  against our **custom** manager, so they are **not redeemable by 1Shot's manager**
  (same root cause as §1.2).
- **Impact:** To use 1Shot for settlement we must sign delegations **for its target**,
  i.e. re-architect the signing rail — not a drop-in.
- **Suggested action:** Support a **configurable DelegationManager target** (or clearly
  document, up front, that delegations must be signed for the canonical manager the
  relayer redeems through), so integrators design for it from day one.

---

## Follow-up — prioritized action items

| # | Area | Action | Why it matters |
|---|---|---|---|
| 1 | ERC-7710 | Document the MetaMask internal-account signing block + ship a smart-account signing example | Highest time-sink; silent failure today |
| 2 | x402 | Mandate `from == delegator` (payer binding) in facilitator guidance | Funds-at-risk without it |
| 3 | 1Shot | Serve the OpenRPC spec at a stable, linked URL + support `rpc.discover` | Integrators can't find the spec |
| 4 | 1Shot | Document chain/relayer onboarding for non-empty capabilities; fix `getFeeData` param parsing | Public relayer can't settle our chains as-is |
| 5 | ERC-7710 / 1Shot | A standard Delegation struct/domain, or a configurable manager target | Unlocks custom-manager ↔ permissionless-relayer portability |
| 6 | ERC-7710 | Ship a deny-by-default reference manager | Makes the secure path the default |
| 7 | x402 | Provide a reference facilitator (capabilities + targetAddress + replay + finality) | Stops every integrator re-implementing security-critical verification |

**Check-in:** revisit after the next integration milestone (mainnet cutover) to see
which of these were resolved upstream vs. still carried as local workarounds in
`packages/contracts`, `packages/server`, and `packages/relayer`.

*Evidence for every item above is in this repo: the custom manager + enforcers
(`packages/contracts/src`, see `SECURITY.md`), the x402 charge path
(`web/lib/*/engine.ts`, `packages/server/src/facilitator`), and the 1Shot adapter
(`packages/relayer/src/oneshot-public.ts`, `web/lib/monopoly/oneshot-relayer.ts`).*
