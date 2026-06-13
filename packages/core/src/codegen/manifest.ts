import { keccak256, stringToHex } from "viem";
import type { GameDefinition } from "../schema/defineGame.js";

/**
 * A deploy manifest is the JSON the CLI consumes to deploy a game's tables and
 * systems. It is derived deterministically from a GameDefinition so the same
 * schema always yields the same table IDs.
 */
export interface ManifestField {
  name: string;
  solidityType: string;
  abiType: string;
}
export interface ManifestTable {
  name: string;
  /** bytes32 table id = keccak256("nexus.<game>.<table>") */
  id: `0x${string}`;
  fields: ManifestField[];
}
export interface ManifestSystem {
  name: string;
  /** bytes32 system id = keccak256("nexus.<game>.<system>") */
  id: `0x${string}`;
  source: string;
}
export interface DeployManifest {
  name: string;
  version: 1;
  tables: ManifestTable[];
  systems: ManifestSystem[];
  economy?: GameDefinition["economy"];
}

export function resourceId(game: string, kind: "table" | "system", name: string): `0x${string}` {
  return keccak256(stringToHex(`nexus.${game}.${kind}.${name}`));
}

/** Build the deploy manifest from a game definition. Pure + deterministic. */
export function buildManifest(game: GameDefinition): DeployManifest {
  const tables: ManifestTable[] = Object.entries(game.tables).map(([name, schema]) => ({
    name,
    id: resourceId(game.name, "table", name),
    fields: Object.entries(schema).map(([fname, ftype]) => ({
      name: fname,
      solidityType: ftype.solidityType,
      abiType: ftype.abiType,
    })),
  }));
  const systems: ManifestSystem[] = Object.entries(game.systems).map(([name, source]) => ({
    name,
    id: resourceId(game.name, "system", name),
    source,
  }));
  return {
    name: game.name,
    version: 1,
    tables,
    systems,
    ...(game.economy ? { economy: game.economy } : {}),
  };
}
