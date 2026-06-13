import { type Hex, NexusError, asAddress } from "@nexus/types";
import { type Log, decodeEventLog, getAddress, parseAbiItem } from "viem";
import type { Settlement } from "../ports/facilitator.js";

/**
 * The minimal viem `PublicClient` surface `verify()` needs. Declaring it as a
 * narrow port (rather than importing viem's full `PublicClient`) lets tests
 * inject a fake client that returns a known receipt — dependency injection, not
 * mocking of the verify logic itself. The real `DirectRelayer`/`OneShotRelayer`
 * pass a genuine viem client here, so the on-chain confirmation below is real.
 */
export interface ReceiptReaderClient {
  getTransactionReceipt(args: { hash: Hex }): Promise<TransactionReceiptLike>;
}

export interface TransactionReceiptLike {
  status: "success" | "reverted";
  blockNumber: bigint;
  logs: readonly LogLike[];
}

export type LogLike = Pick<Log, "address" | "topics" | "data">;

/** The ERC-20 Transfer event — used to find the settled USDC transfer. */
const TRANSFER_EVENT = parseAbiItem(
  "event Transfer(address indexed from, address indexed to, uint256 value)",
);

export interface VerifyTransferParams {
  /** Mined tx hash (from the webhook StatusEvent). */
  txHash: Hex;
  /** ERC-20 token address (from capabilities) the Transfer must be on. */
  token: Hex;
  /** Expected payer (delegation delegator). */
  payer: Hex;
  /** Expected recipient (pot/seller). */
  recipient: Hex;
  /** Expected amount in smallest unit (decimal string). */
  price: string;
  /** Nonce echoed onto the returned Settlement. */
  nonce: Hex;
}

/**
 * REAL on-chain settlement verification (backend spec §4.6). Given a mined tx
 * hash, read the receipt and assert it carries an ERC-20
 * `Transfer(from=payer, to=recipient, value=price)` log on the capabilities
 * token. The `client` is injected so tests can supply a known receipt without a
 * live chain — the assertion logic exercised is the production logic.
 */
export async function verifyTransferOnChain(
  client: ReceiptReaderClient,
  params: VerifyTransferParams,
): Promise<Settlement> {
  let receipt: TransactionReceiptLike;
  try {
    receipt = await client.getTransactionReceipt({ hash: params.txHash });
  } catch (err) {
    throw new NexusError("SETTLEMENT_FAILED", `receipt not found for ${params.txHash}`, {
      cause: err,
      retryable: true,
    });
  }

  if (receipt.status !== "success") {
    throw new NexusError("SETTLEMENT_FAILED", `tx reverted: ${params.txHash}`, {
      txHash: params.txHash,
    });
  }

  const token = getAddress(params.token);
  const payer = asAddress(params.payer);
  const recipient = asAddress(params.recipient);
  const want = BigInt(params.price);

  for (const log of receipt.logs) {
    if (getAddress(log.address) !== token) continue;
    let decoded: { from: Hex; to: Hex; value: bigint };
    try {
      const ev = decodeEventLog({
        abi: [TRANSFER_EVENT],
        topics: log.topics,
        data: log.data,
      });
      decoded = ev.args as unknown as { from: Hex; to: Hex; value: bigint };
    } catch {
      continue; // not a Transfer log on this token
    }
    if (
      asAddress(decoded.from) === payer &&
      asAddress(decoded.to) === recipient &&
      decoded.value === want
    ) {
      return {
        nonce: params.nonce,
        txHash: params.txHash,
        blockNumber: Number(receipt.blockNumber),
        amount: params.price,
        token: token as Hex,
        from: payer,
        to: recipient,
        status: "settled",
      };
    }
  }

  throw new NexusError(
    "SETTLEMENT_FAILED",
    `no matching USDC Transfer(${payer} -> ${recipient}, ${want}) in ${params.txHash}`,
    { txHash: params.txHash },
  );
}
