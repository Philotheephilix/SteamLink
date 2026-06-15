/**
 * SERVER-ONLY — the 1Shot Permissionless **Public Relayer** rail for Monopoly,
 * enabled by `MONOPOLY_RELAYER=oneshot`.
 *
 * This is a self-contained port of `@steamlink/relayer`'s `OneShotPublicRelayer`
 * (vendored here so the rail works without republishing that package). It speaks
 * the relayer's JSON-RPC surface (OpenRPC 1.4.1 — see
 * https://1shotapi.com/docs/api-reference/public-relayer):
 *
 *   relayer_getCapabilities · relayer_send7710Transaction · relayer_getStatus
 *
 * The relayer pays gas in a stablecoin and redeems the player's single ERC-7710
 * delegation against ITS OWN DelegationManager (`targetAddress` from
 * capabilities). The default `direct` rail (lib/engine) self-relays through the
 * project's funded key + custom NexusDelegationManager instead.
 *
 * ⚠️ On-chain prerequisite: a 7710 redemption only settles if the delegation's
 * `delegate` equals the relayer's `targetAddress`. Monopoly's demo delegations
 * are signed for the project relayer (RELAYER_ADDRESS), so `bootOneShot()` runs a
 * startup guard that WARNS when the configured relayer target won't accept them.
 */
import type { SignedDelegation } from "@steamlink/core";
import type { Address, Hex } from "@steamlink/types";

// ── wire types (mirror the OpenRPC content descriptors) ──

interface RelayCaveat {
  enforcer: Address;
  terms: Hex;
  args: Hex;
}
interface RelayDelegation {
  delegate: Address;
  delegator: Address;
  authority: Hex;
  caveats: RelayCaveat[];
  salt: Hex;
  signature: Hex;
}
interface Execution {
  target: Address;
  value: Hex;
  data: Hex;
}
interface ChainCapabilities {
  feeCollector: Address;
  targetAddress: Address;
  tokens: { address: Address; symbol: string; decimals: string | number }[];
}
interface RelayStatusResult {
  id: string;
  chainId: string;
  status: number;
  hash?: Hex;
  receipt?: { blockNumber: string; transactionHash: Hex };
  message?: string;
  data?: unknown;
}

const RELAY_STATUS = { QUEUED: 100, SUBMITTED: 110, SUCCESS: 200, CLIENT_ERROR: 400, SERVER_ERROR: 500 };

export interface OneShotConfig {
  endpoint: string;
  chainId: number;
  bearerToken?: string;
  destinationUrl?: string;
  pollIntervalMs?: number;
  maxPolls?: number;
}

export class OneShotPublicRelayer {
  private readonly chainId: string;
  private rpcId = 0;
  private capsCache?: ChainCapabilities;

  constructor(private readonly cfg: OneShotConfig) {
    if (!cfg.chainId) throw new Error("OneShotPublicRelayer: chainId required");
    this.chainId = `${cfg.chainId}`;
  }

  /** Low-level JSON-RPC call; throws on transport / RPC error. */
  private async rpc<T>(method: string, params: unknown[]): Promise<T> {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (this.cfg.bearerToken) headers.authorization = `Bearer ${this.cfg.bearerToken}`;
    const res = await fetch(this.cfg.endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify({ jsonrpc: "2.0", id: ++this.rpcId, method, params }),
    });
    if (!res.ok) throw new Error(`1Shot ${method} → HTTP ${res.status}`);
    const json = (await res.json()) as { result?: T; error?: { code?: number; message?: string } };
    if (json.error) throw new Error(`1Shot ${method} error ${json.error.code ?? "?"}: ${json.error.message ?? "unknown"}`);
    return json.result as T;
  }

  /** Per-chain capabilities (cached). Source of truth for the relayer targetAddress. */
  async getCapabilities(): Promise<ChainCapabilities> {
    if (this.capsCache) return this.capsCache;
    const raw = await this.rpc<Record<string, ChainCapabilities>>("relayer_getCapabilities", [[this.chainId]]);
    const entry = raw?.[this.chainId];
    if (!entry?.targetAddress) throw new Error(`1Shot serves no capabilities for chain ${this.chainId}`);
    this.capsCache = entry;
    return entry;
  }

  /**
   * Redeem a single player delegation gaslessly: build the ERC-7710 bundle
   * (permissionContext = the signed delegation; executions = the packed call),
   * submit it, and poll to a terminal status. Resolves with the broadcast hash.
   */
  async redeem(signed: SignedDelegation, packedExecution: Hex): Promise<{ txHash: Hex }> {
    const transaction = {
      permissionContext: [toRelayDelegation(signed)],
      executions: [unpackExecution(packedExecution)],
    };
    const params: Record<string, unknown> = { chainId: this.chainId, transactions: [transaction] };
    if (this.cfg.destinationUrl) params.destinationUrl = this.cfg.destinationUrl;

    const taskId = await this.rpc<string>("relayer_send7710Transaction", [params]);
    if (typeof taskId !== "string" || !taskId) throw new Error("1Shot send7710 returned no TaskId");
    return { txHash: await this.awaitHash(taskId) };
  }

  /** Poll relayer_getStatus until SUCCESS (→ hash) or an error status (→ throw). */
  private async awaitHash(id: string): Promise<Hex> {
    const interval = this.cfg.pollIntervalMs ?? 2500;
    const max = this.cfg.maxPolls ?? 120;
    for (let i = 0; i < max; i++) {
      let s: RelayStatusResult | undefined;
      try {
        s = await this.rpc<RelayStatusResult>("relayer_getStatus", [{ id, logs: false }]);
      } catch {
        await sleep(interval);
        continue;
      }
      if (s.status === RELAY_STATUS.SUCCESS && s.receipt?.transactionHash) return s.receipt.transactionHash;
      if (s.status === RELAY_STATUS.CLIENT_ERROR || s.status === RELAY_STATUS.SERVER_ERROR) {
        throw new Error(`1Shot relay failed (${s.status}): ${s.message ?? (typeof s.data === "string" ? s.data : "reverted")}`);
      }
      await sleep(interval);
    }
    throw new Error(`1Shot relay ${id} did not reach a terminal status in time`);
  }
}

// ── mapping helpers ──

/**
 * Map a `@steamlink/core` SignedDelegation to the relayer's wire delegation.
 * `salt` is widened bigint → hex; `maxRedemptions` is dropped (the canonical
 * 7710 struct the relayer redeems against does not carry it).
 */
function toRelayDelegation(s: SignedDelegation): RelayDelegation {
  return {
    delegate: s.delegate,
    delegator: s.delegator,
    authority: s.authority,
    caveats: s.caveats.map((c) => ({ enforcer: c.enforcer, terms: c.terms, args: c.args })),
    salt: `0x${s.salt.toString(16)}` as Hex,
    signature: s.signature,
  };
}

/** Unpack the ERC-7579 single execution `target(20) ++ value(32) ++ callData`. */
function unpackExecution(packed: Hex): Execution {
  const hex = packed.slice(2);
  return {
    target: `0x${hex.slice(0, 40)}` as Address,
    value: `0x${stripZeros(hex.slice(40, 104))}` as Hex,
    data: `0x${hex.slice(104)}` as Hex,
  };
}

function stripZeros(word: string): string {
  const t = word.replace(/^0+/, "");
  return t.length ? t : "0";
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
