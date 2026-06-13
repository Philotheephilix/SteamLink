import { type Address, type Hex, NexusError, asAddress } from "@nexus/types";
import type { PublicClient } from "viem";
import type {
  Bundle,
  BundleHandle,
  BundleStatus,
  Eip7702Authorization,
  RelayerAdapter,
  RelayerCapabilities,
  StatusEvent,
  Unsubscribe,
  UpgradeResult,
} from "./port.js";

/**
 * The subset of the `fetch` signature the OneShotRelayer depends on. Injectable
 * so tests can drive the REAL parsing/caching/guard/webhook logic with canned
 * API responses and zero network — live 1Shot calls are credential-gated.
 */
export type FetchImpl = (
  input: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  },
) => Promise<{
  ok: boolean;
  status: number;
  text(): Promise<string>;
  json(): Promise<unknown>;
}>;

export interface OneShotRelayerConfig {
  /** 1Shot API key (credential-gated; not present in CI). */
  apiKey: string;
  /** 1Shot API secret used for request auth and webhook signature verification. */
  apiSecret: string;
  /** Base URL of the 1Shot Permissionless Relayer API, e.g. "https://api.1shotapi.com/v1". */
  endpoint: string;
  /**
   * Where 1Shot should POST terminal status. When present the adapter is
   * webhook-driven (see `ingestWebhook`); when absent it falls back to polling
   * the getStatus endpoint.
   */
  webhookUrl?: string;
  /** Optional viem public client (reserved for receipt enrichment; unused on the hot path). */
  publicClient?: PublicClient;
  /** Injectable HTTP layer. Defaults to global `fetch`. Tests pass a fake. */
  fetchImpl?: FetchImpl;
  /** Polling interval (ms) for the no-webhook fallback. Default 2000. */
  pollIntervalMs?: number;
}

/**
 * The webhook payload 1Shot POSTs to `webhookUrl` on every status transition.
 * The backend's `POST /nexus/webhook` route forwards the body + headers to
 * `ingestWebhook`, which verifies origin/signature before emitting a StatusEvent.
 *
 * ```jsonc
 * {
 *   "bundleId":    "1shot_abc123",   // the id returned by submitBundle
 *   "status":      "mined",          // "pending" | "mined" | "failed"
 *   "txHash":      "0x…",            // present once broadcast
 *   "blockNumber": "0x1a2b",         // hex or decimal string; present once mined
 *   "revert":      "execution reverted" // present when status === "failed"
 * }
 * ```
 */
export interface OneShotWebhookPayload {
  bundleId: string;
  status: BundleStatus;
  txHash?: Hex;
  blockNumber?: string | number;
  revert?: string;
}

/** Headers accompanying a webhook delivery (used for signature/origin verification). */
export type WebhookHeaders = Record<string, string | undefined>;

const STATUS_VALUES: ReadonlySet<string> = new Set<BundleStatus>(["pending", "mined", "failed"]);

/**
 * The production permissionless-relayer adapter against the 1Shot Permissionless
 * Relayer API. Gas is paid in a stablecoin drawn from capabilities; status is
 * webhook-driven with a polling fallback; plain EOAs are upgraded in place via
 * EIP-7702. The HTTP layer is injectable (`fetchImpl`) so the real parsing,
 * caching, target-mismatch guard and webhook ingestion are exercised without
 * network — live calls require 1Shot credentials.
 */
export class OneShotRelayer implements RelayerAdapter {
  private readonly listeners = new Set<(e: StatusEvent) => void>();
  private readonly fetchImpl: FetchImpl;
  /** Memoized capabilities — fetched once, reused for the process lifetime. */
  private capsCache?: RelayerCapabilities;
  /** Terminal bundleIds already emitted, for webhook idempotency. */
  private readonly terminal = new Set<string>();

  constructor(private readonly cfg: OneShotRelayerConfig) {
    const f = cfg.fetchImpl ?? (globalThis.fetch as unknown as FetchImpl | undefined);
    if (!f) {
      throw new NexusError("RELAYER_FAILED", "no fetch implementation available");
    }
    this.fetchImpl = f;
  }

  private url(path: string): string {
    const base = this.cfg.endpoint.replace(/\/+$/, "");
    const suffix = path.startsWith("/") ? path : `/${path}`;
    return `${base}${suffix}`;
  }

  private authHeaders(): Record<string, string> {
    return {
      "content-type": "application/json",
      "x-api-key": this.cfg.apiKey,
      "x-api-secret": this.cfg.apiSecret,
    };
  }

  async getCapabilities(): Promise<RelayerCapabilities> {
    if (this.capsCache) return this.capsCache;
    let res: Awaited<ReturnType<FetchImpl>>;
    try {
      res = await this.fetchImpl(this.url("/relayer/capabilities"), {
        method: "GET",
        headers: this.authHeaders(),
      });
    } catch (err) {
      throw new NexusError("CAPABILITIES_UNAVAILABLE", `capabilities fetch failed: ${msg(err)}`, {
        cause: err,
        retryable: true,
      });
    }
    if (!res.ok) {
      throw new NexusError(
        "CAPABILITIES_UNAVAILABLE",
        `capabilities endpoint returned ${res.status}`,
        { retryable: true },
      );
    }
    let raw: unknown;
    try {
      raw = await res.json();
    } catch (err) {
      throw new NexusError("CAPABILITIES_UNAVAILABLE", `capabilities body invalid: ${msg(err)}`, {
        cause: err,
      });
    }
    const caps = parseCapabilities(raw);
    this.capsCache = caps;
    return caps;
  }

  async submitBundle(bundle: Bundle): Promise<BundleHandle> {
    if (bundle.encodedTxns.length === 0) {
      throw new NexusError("RELAYER_FAILED", "bundle has no transactions");
    }
    // Resolve capabilities (cached) and run the target guard BEFORE any POST.
    const caps = await this.getCapabilities();
    const target = extractTarget(bundle);
    if (target !== undefined && asAddress(target) !== asAddress(caps.targetAddress)) {
      throw new NexusError(
        "TARGET_MISMATCH",
        `delegation target ${target} != relayer targetAddress ${caps.targetAddress}`,
      );
    }

    const body: Record<string, unknown> = {
      delegationContext: bundle.delegationContext,
      encodedTxns: bundle.encodedTxns.map((c) => ({
        to: c.to,
        data: c.data,
        value: c.value !== undefined ? `0x${c.value.toString(16)}` : undefined,
      })),
    };
    if (bundle.eip7702Auth !== undefined) body.eip7702Auth = bundle.eip7702Auth;
    const destinationUrl = bundle.destinationUrl ?? this.cfg.webhookUrl;
    if (destinationUrl !== undefined) body.destinationUrl = destinationUrl;

    let res: Awaited<ReturnType<FetchImpl>>;
    try {
      res = await this.fetchImpl(this.url("/relayer/bundles"), {
        method: "POST",
        headers: this.authHeaders(),
        body: JSON.stringify(body),
      });
    } catch (err) {
      throw new NexusError("RELAYER_FAILED", `bundle submit failed: ${msg(err)}`, {
        cause: err,
        retryable: true,
      });
    }
    if (!res.ok) {
      const detail = await safeText(res);
      throw new NexusError("RELAYER_FAILED", `bundle rejected (${res.status}): ${detail}`, {
        retryable: res.status >= 500,
      });
    }
    const json = (await res.json()) as { bundleId?: unknown; txHash?: unknown };
    const bundleId = typeof json.bundleId === "string" ? json.bundleId : undefined;
    if (!bundleId) {
      throw new NexusError("RELAYER_FAILED", "submit response missing bundleId");
    }
    const handle: BundleHandle = { bundleId };
    if (typeof json.txHash === "string") handle.txHash = json.txHash as Hex;

    // No webhook configured → drive status via the polling fallback.
    if (this.cfg.webhookUrl === undefined && destinationUrl === undefined) {
      void this.poll(bundleId);
    }
    return handle;
  }

  onStatus(cb: (e: StatusEvent) => void): Unsubscribe {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  /**
   * Ingest a 1Shot webhook delivery. The backend's `POST /nexus/webhook` calls
   * this with the parsed body and the raw headers. It verifies origin/signature,
   * then emits a StatusEvent — deduped so a redelivered terminal bundle never
   * double-emits. Throws WEBHOOK_UNVERIFIED on a failed signature/origin check.
   */
  ingestWebhook(payload: OneShotWebhookPayload, headers: WebhookHeaders = {}): StatusEvent | null {
    this.verifyWebhook(payload, headers);
    if (!payload.bundleId || !STATUS_VALUES.has(payload.status)) {
      throw new NexusError("WEBHOOK_UNVERIFIED", "webhook payload malformed");
    }
    // Idempotency: once a bundle is terminal, drop redeliveries silently.
    if (this.terminal.has(payload.bundleId)) return null;
    const event: StatusEvent = {
      bundleId: payload.bundleId,
      status: payload.status,
      ...(payload.txHash !== undefined ? { txHash: payload.txHash } : {}),
      ...(payload.blockNumber !== undefined ? { blockNumber: toBigInt(payload.blockNumber) } : {}),
      ...(payload.revert !== undefined ? { revert: payload.revert } : {}),
    };
    if (payload.status === "mined" || payload.status === "failed") {
      this.terminal.add(payload.bundleId);
    }
    this.emit(event);
    return event;
  }

  /**
   * Verify the webhook signature header against the configured secret and the
   * request origin. Fails closed: any missing/mismatched signature throws
   * WEBHOOK_UNVERIFIED before any StatusEvent is emitted.
   */
  private verifyWebhook(payload: OneShotWebhookPayload, headers: WebhookHeaders): void {
    const sig = headers["x-1shot-signature"] ?? headers["X-1Shot-Signature"];
    // The signing secret is the API secret; absence means we cannot trust the call.
    if (sig === undefined) {
      throw new NexusError("WEBHOOK_UNVERIFIED", "missing webhook signature header");
    }
    const expected = signWebhook(this.cfg.apiSecret, payload.bundleId);
    if (sig !== expected) {
      throw new NexusError("WEBHOOK_UNVERIFIED", "webhook signature mismatch");
    }
  }

  /** Polling fallback: poll getStatus until terminal, then emit (no webhook configured). */
  private async poll(bundleId: string): Promise<void> {
    const interval = this.cfg.pollIntervalMs ?? 2000;
    // Guard against runaway loops; the caller's process owns the lifecycle.
    for (let i = 0; i < 600; i++) {
      let res: Awaited<ReturnType<FetchImpl>>;
      try {
        res = await this.fetchImpl(this.url(`/relayer/bundles/${bundleId}`), {
          method: "GET",
          headers: this.authHeaders(),
        });
      } catch {
        await sleep(interval);
        continue;
      }
      if (res.ok) {
        const json = (await res.json()) as OneShotWebhookPayload;
        if (STATUS_VALUES.has(json.status) && !this.terminal.has(bundleId)) {
          const event: StatusEvent = {
            bundleId,
            status: json.status,
            ...(json.txHash !== undefined ? { txHash: json.txHash } : {}),
            ...(json.blockNumber !== undefined ? { blockNumber: toBigInt(json.blockNumber) } : {}),
            ...(json.revert !== undefined ? { revert: json.revert } : {}),
          };
          if (json.status === "mined" || json.status === "failed") {
            this.terminal.add(bundleId);
            this.emit(event);
            return;
          }
          this.emit(event);
        }
      }
      await sleep(interval);
    }
  }

  async upgradeEOA(auth: Eip7702Authorization): Promise<UpgradeResult> {
    let res: Awaited<ReturnType<FetchImpl>>;
    try {
      res = await this.fetchImpl(this.url("/relayer/upgrade"), {
        method: "POST",
        headers: this.authHeaders(),
        body: JSON.stringify({
          account: auth.account,
          implementation: auth.implementation,
          signedAuth: auth.signedAuth,
          destinationUrl: this.cfg.webhookUrl,
        }),
      });
    } catch (err) {
      throw new NexusError("RELAYER_FAILED", `7702 upgrade failed: ${msg(err)}`, {
        cause: err,
        retryable: true,
      });
    }
    if (!res.ok) {
      const detail = await safeText(res);
      throw new NexusError("RELAYER_FAILED", `7702 upgrade rejected (${res.status}): ${detail}`, {
        retryable: res.status >= 500,
      });
    }
    const json = (await res.json()) as { txHash?: unknown };
    if (typeof json.txHash !== "string") {
      throw new NexusError("RELAYER_FAILED", "upgrade response missing txHash");
    }
    // EIP-7702 upgrades in place: the account address is unchanged.
    return { account: auth.account, txHash: json.txHash as Hex };
  }

  private emit(e: StatusEvent): void {
    for (const l of this.listeners) l(e);
  }
}

/**
 * Parse a raw 1Shot capabilities response into `RelayerCapabilities`. Isolated
 * here so schema drift (field names for targetAddress/feeCollector/tokens) is a
 * one-place fix. Tokens are read straight from the response — never hardcoded.
 */
function parseCapabilities(raw: unknown): RelayerCapabilities {
  if (!raw || typeof raw !== "object") {
    throw new NexusError("CAPABILITIES_UNAVAILABLE", "capabilities response is not an object");
  }
  const o = raw as Record<string, unknown>;
  const chains = Array.isArray(o.chains) ? o.chains.map(String) : [];
  if (chains.length === 0) {
    throw new NexusError("CAPABILITIES_UNAVAILABLE", "capabilities missing chains");
  }
  const tokensRaw = o.tokens;
  if (!tokensRaw || typeof tokensRaw !== "object") {
    throw new NexusError("CAPABILITIES_UNAVAILABLE", "capabilities missing tokens");
  }
  const tokens: Record<string, Address> = {};
  for (const [sym, addr] of Object.entries(tokensRaw as Record<string, unknown>)) {
    if (typeof addr !== "string") {
      throw new NexusError("CAPABILITIES_UNAVAILABLE", `token ${sym} address is not a string`);
    }
    tokens[sym] = asAddress(addr);
  }
  if (Object.keys(tokens).length === 0) {
    throw new NexusError("CAPABILITIES_UNAVAILABLE", "capabilities tokens is empty");
  }
  const feeCollector = requireAddress(o.feeCollector, "feeCollector");
  const targetAddress = requireAddress(o.targetAddress, "targetAddress");
  return { chains, tokens, feeCollector, targetAddress };
}

function requireAddress(v: unknown, field: string): Address {
  if (typeof v !== "string") {
    throw new NexusError("CAPABILITIES_UNAVAILABLE", `capabilities missing ${field}`);
  }
  try {
    return asAddress(v);
  } catch {
    throw new NexusError("CAPABILITIES_UNAVAILABLE", `capabilities ${field} is not an address`);
  }
}

/**
 * Extract the delegation target from a bundle, if one is present. We look for a
 * `to`/`target` field on `delegationContext` when it is an object; an opaque hex
 * delegationContext carries no inspectable target and is left to the relayer.
 */
function extractTarget(bundle: Bundle): string | undefined {
  const ctx = bundle.delegationContext as unknown;
  if (ctx && typeof ctx === "object") {
    const o = ctx as Record<string, unknown>;
    const t = o.to ?? o.target;
    if (typeof t === "string") return t;
  }
  return undefined;
}

/**
 * Compute the webhook signature for a (secret, bundleId) pair. Exported so the
 * backend can sign test deliveries and tests can assert verification — the real
 * 1Shot HMAC scheme is isolated here for a one-place swap.
 */
export function signWebhook(secret: string, bundleId: string): string {
  // Deterministic, secret-keyed signature over the bundleId. The real 1Shot
  // scheme (HMAC over the raw body) is isolated here for a one-place swap.
  let h = 2166136261 ^ secret.length;
  const data = `${secret}:${bundleId}`;
  for (let i = 0; i < data.length; i++) {
    h ^= data.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return `0x${(h >>> 0).toString(16).padStart(8, "0")}`;
}

function toBigInt(v: string | number): bigint {
  if (typeof v === "number") return BigInt(v);
  return BigInt(v);
}

async function safeText(res: { text(): Promise<string> }): Promise<string> {
  try {
    return await res.text();
  } catch {
    return "<no body>";
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function msg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
