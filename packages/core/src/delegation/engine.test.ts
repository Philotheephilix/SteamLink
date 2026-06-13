import { recoverTypedDataAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import { DELEGATION_TYPES, eip712Domain } from "./eip712.js";
import {
  buildBudgetCaveats,
  buildGameplayCaveats,
  buildMoveExecution,
  buildRedeemCalldata,
  encodePermissionContext,
  signDelegation,
  usdcToWei,
} from "./engine.js";
import type { DeploymentAddresses, GameDelegationConfig } from "./types.js";

const A = (n: string) => `0x${n.repeat(40)}` as `0x${string}`;
const addrs: DeploymentAddresses = {
  world: A("1"),
  delegationManager: A("2"),
  turnManager: A("3"),
  usdc: A("4"),
  enforcers: {
    turnBound: A("a"),
    systemAllowlist: A("b"),
    timestamp: A("c"),
    limitedCalls: A("d"),
    perActionCap: A("e"),
    erc20TransferAmount: A("f"),
    allowedRecipients: A("1"),
  },
};

const config: GameDelegationConfig = {
  gameplay: {
    allowedSystems: [`0x${"11".repeat(32)}`],
    turnBound: true,
    expiresAt: 1_900_000_000_000,
    maxActions: 50,
  },
  budget: { token: "USDC", totalCap: "5", perActionCap: "5", allowedRecipients: [A("9")] },
};

describe("caveat builders", () => {
  it("builds gameplay caveats in order: allowlist, turn, timestamp, limit", () => {
    const cav = buildGameplayCaveats(config, addrs, 1n);
    expect(cav.map((c) => c.enforcer)).toEqual([
      addrs.enforcers.systemAllowlist,
      addrs.enforcers.turnBound,
      addrs.enforcers.timestamp,
      addrs.enforcers.limitedCalls,
    ]);
  });

  it("omits turn/limit when not configured", () => {
    const cfg = {
      ...config,
      gameplay: { allowedSystems: config.gameplay.allowedSystems, expiresAt: 1 },
    };
    expect(buildGameplayCaveats(cfg, addrs, 1n)).toHaveLength(2);
  });

  it("budget caveat targets the per-action cap enforcer", () => {
    expect(buildBudgetCaveats(config, addrs)[0]!.enforcer).toBe(addrs.enforcers.perActionCap);
  });
});

describe("usdcToWei", () => {
  it("uses 6 decimals", () => {
    expect(usdcToWei("5")).toBe(5_000_000n);
    expect(usdcToWei("0.02")).toBe(20_000n);
  });
});

describe("signDelegation", () => {
  // Anvil default account #0.
  const player = privateKeyToAccount(
    "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  );

  it("produces a signature recoverable to the delegator (EIP-712 roundtrip)", async () => {
    const caveats = buildGameplayCaveats(config, addrs, 1n);
    const signed = await signDelegation(player, {
      chainId: 84532,
      delegationManager: addrs.delegationManager,
      delegate: A("7"),
      caveats,
    });
    expect(signed.delegator).toBe(player.address);
    const recovered = await recoverTypedDataAddress({
      domain: eip712Domain(84532, addrs.delegationManager),
      types: DELEGATION_TYPES,
      primaryType: "Delegation",
      message: {
        delegate: signed.delegate,
        delegator: signed.delegator,
        authority: signed.authority,
        caveats: signed.caveats,
        salt: signed.salt,
        maxRedemptions: signed.maxRedemptions,
      },
      signature: signed.signature,
    });
    expect(recovered).toBe(player.address);
  });

  it("encodes a permission context and redeem calldata without throwing", async () => {
    const signed = await signDelegation(player, {
      chainId: 84532,
      delegationManager: addrs.delegationManager,
      delegate: A("7"),
      caveats: buildGameplayCaveats(config, addrs, 1n),
    });
    const ctx = encodePermissionContext(signed);
    const exec = buildMoveExecution(addrs, config.gameplay.allowedSystems[0]!, "0xdeadbeef");
    const redeem = buildRedeemCalldata(ctx, exec);
    expect(ctx).toMatch(/^0x/);
    // packed execution = target(20) ++ value(32) ++ callData; first 20 bytes are the World.
    expect(exec.toLowerCase().startsWith(addrs.world.toLowerCase())).toBe(true);
    expect(redeem).toMatch(/^0x[0-9a-f]+$/);
  });
});
