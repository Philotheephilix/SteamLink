import { type Address, NexusError } from "@nexus/types";
import type { GameModule, RoomConfig, RoomId, RoomState, Session } from "../types.js";
import type { GameDelegation } from "../types.js";
import { type CaveatPolicy, validateCaveats } from "./caveats.js";
import { assertCanJoin, transition } from "./lifecycle.js";
import type { SessionStore } from "./store.js";

interface RoomRecord {
  roomId: RoomId;
  game: string;
  config: RoomConfig;
  state: RoomState;
  members: Address[];
}

// Process-global monotonic counters mint human-readable ids (`room-N`/`sess-N`).
// Module-level (not per-instance) so ids stay unique even if multiple RoomService
// instances are constructed in the same process (e.g. tests, serverless reuse).
let roomSeq = 0;
let sessionSeq = 0;

export interface RoomServiceDeps {
  store: SessionStore;
  games: Map<string, GameModule>;
  /** Returns the caveat policy for a given game/target. */
  caveatPolicy: () => CaveatPolicy;
}

/**
 * Owns room lifecycle and sessions (backend spec §4.2). `createRoom`/`joinRoom`/
 * `leaveRoom` plus membership and state. Holds the signed `GameDelegation` in the
 * `SessionStore` for later redemption by the move/charge lifecycles.
 */
export class RoomService {
  private readonly rooms = new Map<RoomId, RoomRecord>();

  constructor(private readonly deps: RoomServiceDeps) {}

  async createRoom(game: string, config: RoomConfig): Promise<RoomId> {
    if (!this.deps.games.has(game)) {
      throw new NexusError("INVALID_CONFIG", `unknown game "${game}"`);
    }
    const roomId = `room-${++roomSeq}`;
    this.rooms.set(roomId, {
      roomId,
      game,
      config: { ...config, quorum: config.quorum ?? 2 },
      state: "open",
      members: [],
    });
    return roomId;
  }

  getRoom(roomId: RoomId): RoomRecord {
    const room = this.rooms.get(roomId);
    if (!room) throw new NexusError("SESSION_NOT_FOUND", `room ${roomId} not found`);
    return room;
  }

  state(roomId: RoomId): RoomState {
    return this.getRoom(roomId).state;
  }

  /**
   * Join a room with a signed delegation. Validates caveat sanity, persists the
   * delegation in the session store, advances `open → filling`, and on reaching
   * quorum, `filling → active`. Returns the `Session` the SDK reuses for every
   * subsequent move/charge — no further wallet prompt.
   */
  async joinRoom(roomId: RoomId, delegation: GameDelegation): Promise<Session> {
    const room = this.getRoom(roomId);
    assertCanJoin(room.state);

    const game = this.deps.games.get(room.game);
    if (!game) throw new NexusError("INVALID_CONFIG", `unknown game "${room.game}"`);
    validateCaveats(delegation, game, this.deps.caveatPolicy());

    const session: Session = {
      sessionId: `sess-${++sessionSeq}`,
      roomId,
      player: delegation.player,
      delegation,
      createdAt: Date.now(),
    };
    await this.deps.store.put(session);

    if (!room.members.includes(delegation.player)) room.members.push(delegation.player);
    // Two-step advance in one join: the first member moves open→filling, and the
    // member that reaches quorum moves filling→active in the same call (so a
    // single-quorum room becomes active on its first join).
    if (room.state === "open") room.state = transition(room.state, "fill");
    if (room.state === "filling" && room.members.length >= room.config.quorum) {
      room.state = transition(room.state, "quorum");
    }
    return session;
  }

  /** Remove a player; invalidate their session. Returns a (relayed) refund stub. */
  async leaveRoom(roomId: RoomId, who: Address): Promise<{ player: Address; amount: string }> {
    const room = this.getRoom(roomId);
    room.members = room.members.filter((m) => m.toLowerCase() !== who.toLowerCase());
    const sessions = await this.deps.store.byRoom(roomId);
    for (const s of sessions) {
      if (s.player.toLowerCase() === who.toLowerCase()) await this.deps.store.delete(s.sessionId);
    }
    if (room.members.length === 0 && (room.state === "filling" || room.state === "active")) {
      room.state = transition(room.state, "abandon");
    }
    return { player: who, amount: "0" };
  }

  /** Move a room to settling (game ended). */
  end(roomId: RoomId): void {
    const room = this.getRoom(roomId);
    room.state = transition(room.state, "end");
  }

  /** Mark settled → closed. */
  close(roomId: RoomId): void {
    const room = this.getRoom(roomId);
    room.state = transition(room.state, "paid");
  }

  isMember(roomId: RoomId, who: Address): boolean {
    return this.getRoom(roomId).members.some((m) => m.toLowerCase() === who.toLowerCase());
  }
}
