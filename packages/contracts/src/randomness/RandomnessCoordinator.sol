// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

/**
 * @title IRandomnessConsumer
 * @notice The fulfillment seam for a FUTURE Chainlink VRF tier (the `vrf` tier in
 *         design §9 / phase-09). A VRF consumer contract would call this back once
 *         the oracle delivers words. It is intentionally a SEAM only: the on-chain
 *         oracle wiring (`VRFConsumerBaseV2Plus`, `requestRandomWords`,
 *         `fulfillRandomWords`) is NOT implemented here because Chainlink VRF v2.5
 *         requires a funded subscription on Base which is not available in CI.
 *
 * @dev    A future `VRFRandomnessTier` would: (1) hold the subscription credentials,
 *         (2) submit `requestRandomWords`, (3) on `fulfillRandomWords` invoke
 *         `onRandomnessFulfilled(requestId, words)` on the registered consumer. This
 *         interface lets game systems integrate the async tier today against a mock.
 */
interface IRandomnessConsumer {
    /// @notice Called by a (future) VRF tier when the oracle delivers random words.
    /// @param requestId The opaque request id returned at request time.
    /// @param randomWords The fulfilled random words.
    function onRandomnessFulfilled(uint256 requestId, uint256[] calldata randomWords) external;
}

/**
 * @title RandomnessCoordinator
 * @notice Fully on-chain randomness for the Nexus game engine (design §9, phase-09).
 *         Exposes two tiers that need NO external oracle, so they run live on Base
 *         Sepolia with no VRF subscription:
 *
 *           1. `commit-reveal` (trustless): the requester commits `keccak256(secret)`
 *              in one tx, then reveals `secret` in a LATER block. The random word is
 *              `keccak256(secret, blockhash(commitBlock), requester)`. Unbiasable by
 *              any single party — the committer locks in `secret` before the
 *              commit-block hash is known, and the chain fixes `blockhash` after.
 *
 *           2. `fast` (prevrandao): a single-call word
 *              `keccak256(block.prevrandao, block.timestamp, requester, nonce)`.
 *              Cheap, but the beacon proposer can weakly influence `prevrandao`, so
 *              this tier is documented as LOW-STAKES / non-adversarial only.
 *
 *         A future `vrf` tier (Chainlink VRF v2.5) plugs in via `IRandomnessConsumer`
 *         (see the interface above) — left as a documented seam, not wired here,
 *         because VRF needs a funded subscription unavailable in CI.
 *
 * @dev    SECURITY (audit C3). The blockhash/prevrandao tiers are GRINDABLE by an
 *         untrusted party who can choose whether to use an outcome (the committer
 *         learns the result before deciding to reveal). To remove player-side
 *         grinding, the randomness PRODUCERS (`requestCommit`, `fastRandom`) are
 *         gated to AUTHORIZED callers — the game systems / relayer backend, which
 *         is already the trusted driver of the game — NOT arbitrary players. A
 *         player can therefore never request-and-grind their own roll. `reveal`
 *         stays bound to the original requester.
 *
 *         For any payout-affecting roll the PRODUCTION path is the `vrf` tier
 *         (Chainlink VRF v2.5, via {IRandomnessConsumer}); the commit-reveal/fast
 *         tiers are for relayer-driven, non-adversarial use only.
 */
contract RandomnessCoordinator {
    // ─────────────────────────────────────────────────────────────────────────
    // access control (C3): only authorized producers may request randomness
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice Admin that manages the authorized-producer set.
    address public admin;
    /// @notice Accounts permitted to call `requestCommit` / `fastRandom`.
    mapping(address producer => bool) public authorized;

    error Randomness_NotAdmin();
    error Randomness_NotAuthorized(address caller);

    event Randomness_Authorized(address indexed producer, bool ok);

    constructor(address _admin) {
        admin = _admin;
        authorized[_admin] = true;
        emit Randomness_Authorized(_admin, true);
    }

    modifier onlyAuthorized() {
        if (!authorized[msg.sender]) revert Randomness_NotAuthorized(msg.sender);
        _;
    }

    /// @notice Grant/revoke a randomness producer (the game backend / relayer).
    function authorize(address producer, bool ok) external {
        if (msg.sender != admin) revert Randomness_NotAdmin();
        authorized[producer] = ok;
        emit Randomness_Authorized(producer, ok);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Tiers
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice The randomness tiers behind this coordinator (design §9 §7 table).
    enum Tier {
        Vrf, // future Chainlink VRF v2.5 — SEAM ONLY (see IRandomnessConsumer)
        CommitReveal, // two-tx, trustless, no oracle
        Fast // single-tx prevrandao, low-stakes only
    }

    // ─────────────────────────────────────────────────────────────────────────
    // commit-reveal state
    // ─────────────────────────────────────────────────────────────────────────

    struct Commitment {
        address requester; // bound at commit time; only this account may reveal
        bytes32 commitment; // keccak256(secret)
        uint64 commitBlock; // block.number of the commit tx
        bool revealed; // set once on reveal; blocks double-reveal
    }

    /// @notice requestId => commitment record.
    mapping(uint256 => Commitment) public commitments;

    /// @notice Monotonic id source for commit-reveal requests (starts at 1).
    uint256 public nextRequestId = 1;

    // ─────────────────────────────────────────────────────────────────────────
    // fast (prevrandao) state
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice Per-requester nonce so successive `fastRandom()` calls differ even
    ///         within the same block (where prevrandao/timestamp are constant).
    mapping(address => uint256) public fastNonce;

    // ─────────────────────────────────────────────────────────────────────────
    // events
    // ─────────────────────────────────────────────────────────────────────────

    event CommitmentMade(uint256 indexed requestId, address indexed requester, bytes32 commitment, uint64 commitBlock);
    event Revealed(uint256 indexed requestId, address indexed requester, uint256 randomWord);
    event FastRandom(address indexed requester, uint256 indexed nonce, uint256 randomWord);

    // ─────────────────────────────────────────────────────────────────────────
    // named errors
    // ─────────────────────────────────────────────────────────────────────────

    error Randomness_UnknownRequest(uint256 requestId);
    error Randomness_NotRequester(uint256 requestId, address caller);
    error Randomness_RevealTooEarly(uint256 requestId); // reveal in the commit block
    error Randomness_AlreadyRevealed(uint256 requestId);
    error Randomness_BadReveal(uint256 requestId); // keccak256(secret) != commitment
    error Randomness_BlockhashUnavailable(uint256 requestId); // commit >256 blocks old
    error Randomness_BadDiceParams(); // sides == 0 or count == 0

    // ─────────────────────────────────────────────────────────────────────────
    // commit-reveal tier
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * @notice Tier 1, step 1: commit `keccak256(secret)`. The secret stays off-chain
     *         until reveal. Returns a `requestId` bound to `msg.sender`.
     * @param commitment `keccak256(abi.encodePacked(secret))` for a 32-byte secret.
     * @return requestId Identifier to pass to `reveal`.
     */
    function requestCommit(bytes32 commitment) external onlyAuthorized returns (uint256 requestId) {
        requestId = nextRequestId++;
        commitments[requestId] = Commitment({
            requester: msg.sender,
            commitment: commitment,
            commitBlock: uint64(block.number),
            revealed: false
        });
        emit CommitmentMade(requestId, msg.sender, commitment, uint64(block.number));
    }

    /**
     * @notice Tier 1, step 2: reveal `secret`. Computes and returns the random word
     *         `keccak256(secret, blockhash(commitBlock), requester)`.
     *
     * @dev    Enforces, in order: the request exists; the caller is the original
     *         requester; the reveal is in a LATER block than the commit (so the
     *         committer could not have known `blockhash(commitBlock)`); not already
     *         revealed; `keccak256(secret)` matches the commitment; the commit block
     *         hash is still available (within the last 256 blocks).
     *
     * @param requestId The id returned by `requestCommit`.
     * @param secret    The pre-image of the committed hash.
     * @return randomWord The derived random word.
     */
    function reveal(uint256 requestId, bytes32 secret) external returns (uint256 randomWord) {
        Commitment storage c = commitments[requestId];

        if (c.requester == address(0)) revert Randomness_UnknownRequest(requestId);
        if (c.requester != msg.sender) revert Randomness_NotRequester(requestId, msg.sender);
        if (block.number <= c.commitBlock) revert Randomness_RevealTooEarly(requestId);
        if (c.revealed) revert Randomness_AlreadyRevealed(requestId);
        if (keccak256(abi.encodePacked(secret)) != c.commitment) revert Randomness_BadReveal(requestId);

        bytes32 bh = blockhash(c.commitBlock);
        if (bh == bytes32(0)) revert Randomness_BlockhashUnavailable(requestId);

        c.revealed = true; // effects before the (eventless) return — blocks re-reveal
        randomWord = uint256(keccak256(abi.encodePacked(secret, bh, c.requester)));
        emit Revealed(requestId, c.requester, randomWord);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // fast (prevrandao) tier
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * @notice Tier 2: single-call randomness. LOW-STAKES ONLY — a beacon proposer
     *         can weakly bias `block.prevrandao`, so never use this where an attacker
     *         profits from biasing the outcome (use `commit-reveal` or `vrf` there).
     * @return randomWord `keccak256(block.prevrandao, block.timestamp, requester, nonce)`.
     */
    function fastRandom() external onlyAuthorized returns (uint256 randomWord) {
        uint256 nonce = fastNonce[msg.sender]++;
        randomWord = uint256(keccak256(abi.encodePacked(block.prevrandao, block.timestamp, msg.sender, nonce)));
        emit FastRandom(msg.sender, nonce, randomWord);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // dice helper
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * @notice Map a random word into `count` dice rolls each in `[1, sides]`.
     * @dev    Uses rejection sampling to avoid modulo bias: each die consumes a fresh
     *         sub-word `keccak256(randomWord, i)` and rejects draws in the biased tail
     *         (`>= floor(2^256 / sides) * sides`), re-hashing until an unbiased draw
     *         lands. Pure and deterministic from `(randomWord, sides, count)`.
     * @param randomWord The source of entropy (from `reveal`, `fastRandom`, or a future VRF word).
     * @param sides      Faces per die (e.g. 6). Must be > 0.
     * @param count      Number of dice (e.g. 2 for 2d6). Must be > 0.
     * @return rolls      `count` values, each in `[1, sides]`.
     */
    function dice(uint256 randomWord, uint8 sides, uint8 count) external pure returns (uint8[] memory rolls) {
        if (sides == 0 || count == 0) revert Randomness_BadDiceParams();

        rolls = new uint8[](count);
        // Largest multiple of `sides` that fits in uint256; draws at/above this are
        // the biased tail and get rejected.
        uint256 limit = type(uint256).max - (type(uint256).max % sides);

        for (uint256 i = 0; i < count; i++) {
            uint256 draw = uint256(keccak256(abi.encodePacked(randomWord, i)));
            uint256 salt = 0;
            // Rejection sample: re-hash with a salt until the draw is unbiased.
            while (draw >= limit) {
                salt++;
                draw = uint256(keccak256(abi.encodePacked(randomWord, i, salt)));
            }
            rolls[i] = uint8((draw % sides) + 1);
        }
    }
}
