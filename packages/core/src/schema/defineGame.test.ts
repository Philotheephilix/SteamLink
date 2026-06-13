import { describe, expect, it } from "vitest";
import { buildManifest, resourceId } from "../codegen/manifest.js";
import { generateSolidityTables } from "../codegen/solidity.js";
import { defineGame } from "./defineGame.js";
import { t } from "./types.js";

const uno = defineGame({
  name: "uno",
  tables: {
    Player: { id: t.address, roomId: t.uint, isReady: t.bool },
    DiscardPile: { roomId: t.uint, topCard: t.uint8, activeColor: t.uint8 },
    TurnOrder: { roomId: t.uint, current: t.address, direction: t.int8, deadline: t.uint },
  },
  systems: {
    PlayCardSystem: "./systems/PlayCard.sol",
    DrawSystem: "./systems/Draw.sol",
  },
  economy: { entryFee: { amount: "5", token: "USDC" }, pot: { type: "winner-take-all", rake: "0.02" } },
});

describe("defineGame", () => {
  it("accepts a valid definition", () => {
    expect(uno.name).toBe("uno");
    expect(Object.keys(uno.tables)).toHaveLength(3);
  });

  it("rejects an invalid name", () => {
    expect(() => defineGame({ name: "Bad Name", tables: { X: { a: t.bool } }, systems: {} })).toThrow();
  });

  it("rejects an empty table", () => {
    expect(() =>
      defineGame({ name: "g", tables: { Empty: {} }, systems: {} }),
    ).toThrow(/no fields/);
  });

  it("rejects an out-of-range rake", () => {
    expect(() =>
      defineGame({
        name: "g",
        tables: { X: { a: t.bool } },
        systems: {},
        economy: { pot: { type: "split", rake: "1.5" } },
      }),
    ).toThrow(/rake/);
  });
});

describe("manifest", () => {
  it("is deterministic", () => {
    expect(buildManifest(uno)).toEqual(buildManifest(uno));
  });

  it("derives stable table/system ids", () => {
    const m = buildManifest(uno);
    expect(m.tables.find((x) => x.name === "Player")?.id).toBe(resourceId("uno", "table", "Player"));
    expect(m.systems.find((x) => x.name === "PlayCardSystem")?.id).toBe(
      resourceId("uno", "system", "PlayCardSystem"),
    );
    // ids are 32-byte hex
    expect(m.tables[0]!.id).toMatch(/^0x[0-9a-f]{64}$/);
  });
});

describe("solidity codegen", () => {
  it("emits a library with table ids and structs", () => {
    const sol = generateSolidityTables(buildManifest(uno));
    expect(sol).toContain("library UnoTables");
    expect(sol).toContain("Player_ID");
    expect(sol).toContain("struct PlayerRow");
    expect(sol).toContain("address id;");
    expect(sol).toContain("int8 direction;");
    expect(sol).toContain("pragma solidity ^0.8.23;");
  });
});
