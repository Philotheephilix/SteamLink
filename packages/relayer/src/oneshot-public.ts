import { type Address, type Hex, NexusError, asAddress } from "@nexus/types";
import type {
  Bundle,
  BundleHandle,
  BundleStatus,
  Eip7702Authorization,
  RelayDelegation,
  RelayerAdapter,
  RelayerCapabilities,
  SignedAuthorization7702,
  StatusEvent,
  Unsubscribe,
  UpgradeResult,
} from "./port.js";

/**
 * `OneShotPublicRelayer` — the production adapter against the **1Shot Permissionless
 * Public Relayer**, a JSON-RPC surface (OpenRPC 1.4.1) for ERC-7710 delegated,
 * gas-abstracted execution. Gas is paid in a stablecoin drawn from capabilities;
 * a player's single `joinRoom()` delegation is redeemed by the relayer with no
 * further wallet prompt; status is polled (or pushed to `destinationUrl`).
 *
 * Surface implemented (see https://1shotapi.com/docs/api-reference/public-relayer):
 *   relayer_getCapabilities · relayer_getFeeData · relayer_estimate7710Transaction
 *   relayer_send7710Transaction · relayer_getStatus
 *
 * The HTTP layer is injectable (`fetchImpl`) so the real JSON-RPC framing,
 * capability parsing, target guard and status mapping are exercised offline —
 * live calls require a relayer host that serves the configured chain.
 */

/** Endpoints from the OpenRPC `servers` block. Base-only project → pick by network. */
export const ONESHOT_PUBLIC_RELAYER_MAINNET = "https://relayer.1shotapi.com/relayers";
export const ONESHOT_PUBLIC_RELAYER_TESTNET = "https://relayer.1shotapi.dev/relayers";

/** Injectable subset of `fetch`. Tests pass a fake; default is global `fetch`. */
export type FetchImpl = (
  input: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
) => Promise<{ ok: boolean; status: number; text(): Promise<string>; json(): Promise<unknown> }>;

export interface OneShotPublicRelayerConfig {
  /**
   * The numeric chain id the relayer serves, as a string — Base mainnet `"8453"`
   * or Base Sepolia `"84532"`. Used for capabilities lookup and every send.
   */
  chainId: string | number;
  /** Relayer base URL. Defaults to the mainnet host; pass the testnet host for Base Sepolia infra. */
  endpoint?: string;
  /** Optional bearer token (Dev-Platform-authenticated relayer instances). Permissionless calls omit it. */
  bearerToken?: string;
  /** Where the relayer should POST status (sets `destinationUrl` on every send). Polling is the fallback. */
  destinationUrl?: string;
  /** Injectable HTTP layer. Defaults to global `fetch`. */
  fetchImpl?: FetchImpl;
  /** Poll interval (ms) for the status fallback. Default 2000. */
  pollIntervalMs?: number;
  /** Max poll iterations before giving up (runaway guard). Default 600. */
  maxPolls?: number;
}

// ── wire types (mirror the OpenRPC content descriptors exactly) ──

/** `relayer_getCapabilities` → per-chain capability record. */
export interface ChainCapabilities {
  feeCollector: Address;
  targetAddress: Address;
  tokens: { address: Address; symbol: string; decimals: string | number }[];
}

/** `relayer_getFeeData` result. */
export interface FeeData {
  chainId: string;
  token: { address: Address; decimals: number; symbol: string; name: string };
  rate: number;
  minFee: string;
  expiry: number;
  gasPrice: string;
  feeCollector: Address;
  targetAddress: Address;
  /** Opaque signed-quote blob to thread back into a send/estimate as `context`. */
  context?: string;
}

/** One ERC-7710 delegated transaction: a permission-context chain + executions. */
export interface Relay7710Transaction {
  permissionContext: RelayDelegation[];
  executions: { target: Address; value: Hex; data: Hex }[];
}

/** `relayer_send7710Transaction` / `relayer_estimate7710Transaction` params. */
export interface Send7710Params {
  chainId: string;
  transactions: Relay7710Transaction[];
  authorizationList?: SignedAuthorization7702[];
  context?: string;
  taskId?: string;
  destinationUrl?: string;
  memo?: string;
}

/** `relayer_estimate7710Transaction` result. */
export interface Estimate7710Result {
  success: boolean;
  paymentTokenAddress?: Address;
  paymentChain?: number;
  gasUsed: unknown;
  requiredPaymentAmount?: string;
  context?: string;
  contextByChainId?: Record<string, string>;
  error?: string;
}

/** Numeric status codes from `relayer_getStatus`. */
export const RELAY_STATUS = {
  QUEUED: 100,
  SUBMITTED: 110,
  SUCCESS: 200,
  CLIENT_ERROR: 400,
  SERVER_ERROR: 500,
} as const;

/** `relayer_getStatus` result (discriminated by the numeric `status`). */
export interface RelayStatusResult {
  id: string;
  chainId: string;
  createdAt: number;
  status: number;
  memo?: string;
  /** present at SUBMITTED (110) */
  hash?: Hex;
  /** present at SUCCESS (200) */
  receipt?: {
    blockHash: Hex;
    blockNumber: string;
    gasUsed: string;
    transactionHash: Hex;
    logs?: { address: Address; topics: Hex[]; data: Hex }[];
  };
  /** present at CLIENT_ERROR (400) / SERVER_ERROR (500) */
  message?: string;
  data?: unknown;
}

export class OneShotPublicRelayer implements RelayerAdapter {
  private readonly listeners = new Set<(e: StatusEvent) => void>();
  private readonly fetchImpl: FetchImpl;
  private readonly endpoint: string;
  private readonly chainId: string;
  private rpcId = 0;
  private capsCache?: RelayerCapabilities;
  /** Terminal task ids already emitted (poll/ingest idempotency). */
  private readonly terminal = new Set<string>();
  /** idempotencyKey/taskId -> handle, so a retried money submit cannot double-pay. */
  private readonly submittedByKey = new Map<string, BundleHandle>();

  constructor(private readonly cfg: OneShotPublicRelayerConfig) {
    const f = cfg.fetchImpl ?? (globalThis.fetch as unknown as FetchImpl | undefined);
    if (!f) throw new NexusError("INVALID_CONFIG", "no fetch implementation available");
    if (cfg.chainId === undefined || cfg.chainId === null || `${cfg.chainId}` === "")
      throw new NexusError("INVALID_CONFIG", "OneShotPublicRelayer requires a chainId");
    this.fetchImpl = f;
    this.endpoint = (cfg.endpoint ?? ONESHOT_PUBLIC_RELAYER_MAINNET).replace(/\/+$/, "");
    this.chainId = `${cfg.chainId}`;
  }

  /** Low-level JSON-RPC call. `params` is the positional array per the OpenRPC spec. */
  async rpc<T>(method: string, params: unknown[]): Promise<T> {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (this.cfg.bearerToken) headers.authorization = `Bearer ${this.cfg.bearerToken}`;
    const body = JSON.stringify({ jsonrpc: "2.0", id: ++this.rpcId, method, params });

    let res: Awaited<ReturnType<FetchImpl>>;
    try {
      res = await this.fetchImpl(this.endpoint, { method: "POST", headers, body });
    } catch (err) {
      throw new NexusError("RELAYER_FAILED", `${method} request failed: ${msg(err)}`, {
        cause: err,
        retryable: true,
      });
    }
    if (!res.ok) {
      throw new NexusError("RELAYER_FAILED", `${method} returned HTTP ${res.status}`, {
        retryable: res.status >= 500,
      });
    }
    let json: { result?: unknown; error?: { code?: number; message?: string } };
    try {
      json = (await res.json()) as typeof json;
    } catch (err) {
      throw new NexusError("RELAYER_FAILED", `${method} body invalid: ${msg(err)}`, { cause: err });
    }
    if (json.error) {
      throw new NexusError(
        "RELAYER_FAILED",
        `${method} error ${json.error.code ?? "?"}: ${json.error.message ?? "unknown"}`,
      );
    }
    return json.result as T;
  }

  async getCapabilities(): Promise<RelayerCapabilities> {
    if (this.capsCache) return this.capsCache;
    let raw: Record<string, ChainCapabilities>;
    try {
      raw = await this.rpc<Record<string, ChainCapabilities>>("relayer_getCapabilities", [
        [this.chainId],
      ]);
    } catch (err) {
      if (err instanceof NexusError)
        throw new NexusError("CAPABILITIES_UNAVAILABLE", err.message, { cause: err, retryable: true });
      throw err;
    }
    const entry = raw?.[this.chainId];
    if (!entry || !entry.targetAddress || !Array.isArray(entry.tokens)) {
      throw new NexusError(
        "CAPABILITIES_UNAVAILABLE",
        `relayer serves no capabilities for chain ${this.chainId}`,
        { retryable: true },
      );
    }
    const tokens: Record<string, Address> = {};
    for (const tk of entry.tokens) {
      if (tk?.symbol && tk?.address) tokens[tk.symbol] = asAddress(tk.address);
    }
    const caps: RelayerCapabilities = {
      chains: [this.chainId],
      tokens,
      feeCollector: asAddress(entry.feeCollector),
      targetAddress: asAddress(entry.targetAddress),
    };
    this.capsCache = caps;
    return caps;
  }

  /** Fee quote + token pricing metadata for a chain/token pair. */
  async getFeeData(token: Address): Promise<FeeData> {
    return this.rpc<FeeData>("relayer_getFeeData", [{ chainId: this.chainId, token }]);
  }

  /** Synchronous fee/gas estimate for a bundle (does not submit). */
  async estimate(bundle: Bundle): Promise<Estimate7710Result> {
    const params = this.buildSendParams(bundle, await this.getCapabilities());
    return this.rpc<Estimate7710Result>("relayer_estimate7710Transaction", [params]);
  }

  async submitBundle(bundle: Bundle): Promise<BundleHandle> {
    if (bundle.encodedTxns.length === 0)
      throw new NexusError("RELAYER_FAILED", "bundle has no executions");

    // Idempotency: a retried money submit with the same key returns the original handle.
    if (bundle.idempotencyKey) {
      const prior = this.submittedByKey.get(bundle.idempotencyKey);
      if (prior) return prior;
    }

    const caps = await this.getCapabilities();
    const params = this.buildSendParams(bundle, caps);

    const taskId = await this.rpc<string>("relayer_send7710Transaction", [params]);
    if (typeof taskId !== "string" || taskId.length === 0)
      throw new NexusError("RELAYER_FAILED", "send7710 did not return a TaskId");

    const handle: BundleHandle = { bundleId: taskId };
    if (bundle.idempotencyKey) this.submittedByKey.set(bundle.idempotencyKey, handle);

    // No push destination → drive status via the polling fallback.
    if (!params.destinationUrl) void this.poll(taskId);
    return handle;
  }

  /** Build `relayer_send7710Transaction` params, running the target guard first. */
  private buildSendParams(bundle: Bundle, caps: RelayerCapabilities): Send7710Params {
    const permissionContext = (bundle.permissionContext ?? []) as RelayDelegation[];

    // H4 target guard: the delegate (who may redeem) must equal the relayer target.
    const delegate = permissionContext[0]?.delegate;
    if (delegate === undefined) {
      if (bundle.requireTarget)
        throw new NexusError(
          "TARGET_MISMATCH",
          "money bundle has no permissionContext — refusing to submit unguarded",
        );
    } else if (asAddress(delegate) !== asAddress(caps.targetAddress)) {
      throw new NexusError(
        "TARGET_MISMATCH",
        `delegation delegate ${delegate} != relayer targetAddress ${caps.targetAddress}`,
      );
    }

    const transaction: Relay7710Transaction = {
      permissionContext,
      executions: bundle.encodedTxns.map((c) => ({
        target: c.to,
        value: c.value !== undefined ? toHex(c.value) : "0x0",
        data: c.data,
      })),
    };
    const params: Send7710Params = { chainId: this.chainId, transactions: [transaction] };
    const destinationUrl = bundle.destinationUrl ?? this.cfg.destinationUrl;
    if (destinationUrl !== undefined) params.destinationUrl = destinationUrl;
    if (bundle.idempotencyKey !== undefined) params.taskId = bundle.idempotencyKey;
    if (bundle.authorizationList && bundle.authorizationList.length > 0)
      params.authorizationList = [...bundle.authorizationList];
    return params;
  }

  /** Fetch + map the current status of a relayed task to a StatusEvent. */
  async getStatus(id: string): Promise<StatusEvent> {
    const raw = await this.rpc<RelayStatusResult>("relayer_getStatus", [{ id, logs: false }]);
    return mapStatus(id, raw);
  }

  /**
   * Ingest a status object the relayer pushed to `destinationUrl`. Maps + emits,
   * deduped so a redelivered terminal task never double-emits. (The public relayer
   * defines no webhook signature scheme; verify origin at your transport.)
   */
  ingestStatus(raw: RelayStatusResult): StatusEvent | null {
    if (!raw?.id) throw new NexusError("RELAYER_FAILED", "status payload missing id");
    if (this.terminal.has(raw.id)) return null;
    const event = mapStatus(raw.id, raw);
    if (event.status === "mined" || event.status === "failed") this.terminal.add(raw.id);
    this.emit(event);
    return event;
  }

  onStatus(cb: (e: StatusEvent) => void): Unsubscribe {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  /** Poll `relayer_getStatus` until terminal, emitting each transition once. */
  private async poll(id: string): Promise<void> {
    const interval = this.cfg.pollIntervalMs ?? 2000;
    const max = this.cfg.maxPolls ?? 600;
    let lastNonTerminal: BundleStatus | undefined;
    for (let i = 0; i < max; i++) {
      let event: StatusEvent | undefined;
      try {
        event = await this.getStatus(id);
      } catch {
        await sleep(interval);
        continue;
      }
      if (this.terminal.has(id)) return;
      if (event.status === "mined" || event.status === "failed") {
        this.terminal.add(id);
        this.emit(event);
        return;
      }
      // Emit a non-terminal transition once (e.g. queued → submitted-with-hash).
      const fingerprint = `${event.status}:${event.txHash ?? ""}` as BundleStatus;
      if (fingerprint !== lastNonTerminal) {
        lastNonTerminal = fingerprint;
        this.emit(event);
      }
      await sleep(interval);
    }
  }

  /**
   * EIP-7702 upgrades are folded into `submitBundle` via `bundle.authorizationList`
   * on this relayer — there is no standalone upgrade RPC — so this throws to steer
   * callers to the inline path.
   */
  async upgradeEOA(_auth: Eip7702Authorization): Promise<UpgradeResult> {
    throw new NexusError(
      "INVALID_CONFIG",
      "OneShotPublicRelayer folds EIP-7702 upgrades into submitBundle via bundle.authorizationList; there is no standalone upgrade endpoint",
    );
  }

  private emit(e: StatusEvent): void {
    for (const l of this.listeners) l(e);
  }
}

/** Map a raw `relayer_getStatus` result to the port's StatusEvent. */
export function mapStatus(id: string, raw: RelayStatusResult): StatusEvent {
  switch (raw.status) {
    case RELAY_STATUS.SUCCESS: {
      const r = raw.receipt;
      return {
        bundleId: id,
        status: "mined",
        ...(r?.transactionHash ? { txHash: r.transactionHash } : {}),
        ...(r?.blockNumber ? { blockNumber: toBigInt(r.blockNumber) } : {}),
      };
    }
    case RELAY_STATUS.CLIENT_ERROR:
    case RELAY_STATUS.SERVER_ERROR:
      return {
        bundleId: id,
        status: "failed",
        revert: raw.message ?? (typeof raw.data === "string" ? raw.data : "relay failed"),
      };
    case RELAY_STATUS.SUBMITTED:
      return { bundleId: id, status: "pending", ...(raw.hash ? { txHash: raw.hash } : {}) };
    default:
      return { bundleId: id, status: "pending" };
  }
}

function toHex(v: bigint): Hex {
  return `0x${v.toString(16)}` as Hex;
}

function toBigInt(v: string | number): bigint {
  return typeof v === "number" ? BigInt(v) : BigInt(v.startsWith("0x") ? v : v);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function msg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
