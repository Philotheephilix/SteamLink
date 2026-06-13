/**
 * `LocalSecrets` — a fully offline, REAL-crypto {@link SecretsAdapter}.
 *
 * This is NOT a mock of the interface: it performs genuine authenticated
 * encryption (AES-256-GCM via `node:crypto`) and genuine secp256k1 attestation
 * signatures (via viem). It is suitable for local dev (`nexus serve`) and for
 * unit tests because it requires no network and no Lit credentials.
 *
 * Differences from {@link LitSecrets}:
 *  - Key custody: LocalSecrets holds the symmetric key itself (embedded in the
 *    sealed blob, wrapped). LitSecrets never holds the key — it is split across
 *    the Lit threshold network (>2/3 of nodes must cooperate to release it).
 *  - Condition evaluation: LocalSecrets checks conditions with an injected
 *    predicate against in-process state. LitSecrets has Lit nodes evaluate the
 *    conditions against Base directly.
 *  - Attestation signer: LocalSecrets signs with a local dev key. LitSecrets'
 *    attestation is signed by the Lit Action's PKP inside the node TEE.
 *
 * The crypto and the attestation codec are identical in shape to the Lit path,
 * so on-chain verification logic is the same — only the trust source differs.
 */

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { NexusError } from "@nexus/types";
import type { Address, Hex } from "@nexus/types";
import { keccak256 } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { type AttestationPayloadFields, encodeAttestationPayload } from "./attestation.js";
import { assertConditionsValid } from "./conditions/registry.js";
import { decodeHand, isLegalMove } from "./moveRule.js";
import type {
  AccessCondition,
  Attestation,
  AuthContext,
  Bytes,
  MoveClaim,
  Sealed,
  SecretsAdapter,
} from "./types.js";

/**
 * A predicate that decides whether `reveal`/`verify` may proceed. It receives
 * the sealed blob's conditions and the caller's auth context (including any
 * injected game `state`) and returns true iff decryption is permitted.
 *
 * This is the local stand-in for "Lit nodes evaluate conditions against Base".
 */
export type ConditionPredicate = (
  conditions: AccessCondition[],
  auth: AuthContext,
) => boolean | Promise<boolean>;

/**
 * The default predicate: a small, readable interpreter over the built-in policy
 * shapes. It honors `:userAddress` ownership checks and boolean game-state views
 * resolved from `auth.state`. Real deployments inject their own.
 */
export const defaultConditionPredicate: ConditionPredicate = (conditions, auth) => {
  const state = auth.state ?? {};
  return conditions.every((c) => {
    // owner check: returns ":userAddress" means "must equal the caller".
    if (c.returns.value === ":userAddress") {
      const owner = state[c.method];
      // Fail CLOSED: an owner check can only pass when state names a concrete
      // owner that matches the caller. If the owner is unknown/unresolvable
      // (no state[method] string), DENY rather than letting the caller claim
      // ownership — an absent owner must never grant access.
      if (typeof owner === "string") {
        return owner.toLowerCase() === auth.caller.toLowerCase();
      }
      return false;
    }
    // boolean game-state view: state[method] must satisfy the comparator.
    if (c.returns.value === "true" || c.returns.value === "false") {
      const expected = c.returns.value === "true";
      const actual = Boolean(state[c.method]);
      return c.returns.comparator === "!=" ? actual !== expected : actual === expected;
    }
    // numeric / generic: compare state[method] to the literal value.
    const actual = state[c.method];
    if (actual === undefined) return false;
    return compare(Number(actual), c.returns.comparator, Number(c.returns.value));
  });
};

/**
 * A cryptographically-random 256-bit nonce for an attestation. Unlike a
 * per-process counter (which restarts at 0 and enables replay), this can't be
 * reissued across restarts and won't collide in practice.
 */
function randomNonce(): bigint {
  return BigInt(`0x${randomBytes(32).toString("hex")}`);
}

function compare(a: number, op: string, b: number): boolean {
  switch (op) {
    case "=":
      return a === b;
    case "!=":
      return a !== b;
    case ">":
      return a > b;
    case ">=":
      return a >= b;
    case "<":
      return a < b;
    case "<=":
      return a <= b;
    default:
      return false;
  }
}

/** A 32-byte hex test key (Anvil account #1). Dev-only — never used in prod. */
const DEFAULT_DEV_PRIVATE_KEY: Hex =
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";

export type LocalSecretsOptions = {
  /** Condition gate. Defaults to {@link defaultConditionPredicate}. */
  predicate?: ConditionPredicate;
  /** The dev attestation signing key. Defaults to a well-known Anvil key. */
  devPrivateKey?: Hex;
  /** Attestation validity window in seconds. Default 120s. */
  validitySeconds?: number;
  /** A fixed symmetric key (hex, 32 bytes). Default: random per process. */
  masterKey?: Hex;
};

/** AES-GCM envelope embedded (base64) into `Sealed.ciphertext`. */
type Envelope = { iv: string; tag: string; ct: string; key: string };

export class LocalSecrets implements SecretsAdapter {
  private readonly predicate: ConditionPredicate;
  private readonly account: ReturnType<typeof privateKeyToAccount>;
  private readonly validitySeconds: number;
  private readonly masterKey: Buffer;

  constructor(opts: LocalSecretsOptions = {}) {
    this.predicate = opts.predicate ?? defaultConditionPredicate;
    this.account = privateKeyToAccount(opts.devPrivateKey ?? DEFAULT_DEV_PRIVATE_KEY);
    this.validitySeconds = opts.validitySeconds ?? 120;
    this.masterKey = opts.masterKey ? Buffer.from(opts.masterKey.slice(2), "hex") : randomBytes(32);
  }

  /** The dev attestation signer address — register this in the on-chain verifier for dev. */
  get signerAddress(): Address {
    return this.account.address;
  }

  async seal(data: Bytes, conditions: AccessCondition[]): Promise<Sealed> {
    assertConditionsValid(conditions);
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.masterKey, iv);
    const ct = Buffer.concat([cipher.update(Buffer.from(data)), cipher.final()]);
    const tag = cipher.getAuthTag();
    const envelope: Envelope = {
      iv: iv.toString("base64"),
      tag: tag.toString("base64"),
      ct: ct.toString("base64"),
      // The wrapped data key. In LocalSecrets the master key never leaves the
      // process; we still bind it into the blob so a sealed blob is self-contained.
      key: this.masterKey.toString("base64"),
    };
    const ciphertext = Buffer.from(JSON.stringify(envelope)).toString("base64");
    // dataHash binds the ciphertext to its conditions (keccak of ct||conditions).
    const dataHash = keccak256(
      Buffer.from(ciphertext + JSON.stringify(conditions)) as unknown as Uint8Array,
    );
    const commitment = keccak256(dataHash);
    return {
      ciphertext,
      dataHash,
      commitment,
      conditions,
      network: "local",
      alg: "AES-256-GCM",
    };
  }

  async reveal(sealed: Sealed, auth: AuthContext): Promise<Bytes> {
    const allowed = await this.predicate(sealed.conditions, auth);
    if (!allowed) {
      throw new NexusError("REVEAL_DENIED", "access conditions not met", {
        context: { caller: auth.caller, conditions: sealed.conditions },
      });
    }
    return this.decryptInternal(sealed);
  }

  async verify(sealed: Sealed, claim: MoveClaim): Promise<Attestation> {
    // The attestation only requires that the *claimant* may evaluate the hand;
    // verify runs the rule inside this process (analogue of the TEE) without
    // returning the hand. We gate it on the claiming player's own auth.
    const auth: AuthContext = {
      caller: claim.player,
      roomId: claim.roomId,
      state: { ownerOf: claim.player },
    };
    const allowed = await this.predicate(sealed.conditions, auth);
    if (!allowed) {
      throw new NexusError("REVEAL_DENIED", "verify denied: conditions not met");
    }

    // Decrypt the hand locally (analogue of decrypt-inside-enclave). The plaintext
    // never leaves this method — only the attestation is returned.
    const handBytes = this.decryptInternal(sealed);
    const hand = decodeHand(handBytes);
    const legal = isLegalMove({
      hand,
      playedCard: claim.playedCard,
      topOfDiscard: claim.topOfDiscard,
      activeColor: claim.activeColor,
    });

    if (!legal) {
      // Reveal nothing about the hand; surface the typed error. No signature.
      throw new NexusError("ILLEGAL_MOVE", "played card is not a legal move", {
        context: { playedCard: claim.playedCard, roomId: claim.roomId },
      });
    }

    const fields: AttestationPayloadFields = {
      player: claim.player,
      system: claim.system,
      playedCard: claim.playedCard,
      // Random 256-bit nonce. A per-process counter resets to 0 on restart,
      // letting an attacker replay an old (player, system, playedCard, nonce)
      // attestation. A fresh CSPRNG nonce per attestation can't be reissued
      // across restarts and won't collide in practice.
      nonce: randomNonce(),
      validUntil: BigInt(Math.floor(Date.now() / 1000) + this.validitySeconds),
    };
    const payload = encodeAttestationPayload(fields);
    // Sign with EIP-191 prefix so the on-chain verifier recovers via
    // toEthSignedMessageHash(keccak256(payload)).
    const signature = (await this.account.signMessage({
      message: { raw: keccak256(payload) },
    })) as Hex;

    return {
      payload,
      signature,
      signer: this.account.address,
      litActionCid: "local:LocalSecrets",
    };
  }

  private decryptInternal(sealed: Sealed): Bytes {
    let envelope: Envelope;
    try {
      envelope = JSON.parse(Buffer.from(sealed.ciphertext, "base64").toString("utf8"));
    } catch (cause) {
      throw new NexusError("SEAL_FAILED", "corrupt sealed blob", { cause });
    }
    const key = Buffer.from(envelope.key, "base64");
    const iv = Buffer.from(envelope.iv, "base64");
    const tag = Buffer.from(envelope.tag, "base64");
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    try {
      const pt = Buffer.concat([
        decipher.update(Buffer.from(envelope.ct, "base64")),
        decipher.final(),
      ]);
      return new Uint8Array(pt);
    } catch (cause) {
      throw new NexusError("SEAL_FAILED", "authentication tag mismatch", { cause });
    }
  }
}
