import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  buildManifest,
  type DeployManifest,
  type GameDefinition,
  generateSolidityTables,
  solidityLibraryName,
} from "@nexus/core";

export interface CodegenResult {
  manifest: DeployManifest;
  /** Generated Solidity tables library source. */
  tablesSol: string;
  /** Directory the artifacts were written to. */
  outDir: string;
  /** Absolute paths of the files written. */
  files: { manifest: string; tablesSol: string };
}

/**
 * Run codegen for a single game definition: build the deploy manifest and the
 * Solidity tables library, then write both into `outDir`. Pure aside from the
 * filesystem writes — the manifest + sol string are also returned so callers
 * (and tests) can assert on them without re-reading the disk.
 */
export function runCodegen(game: GameDefinition, outDir: string): CodegenResult {
  const manifest = buildManifest(game);
  const tablesSol = generateSolidityTables(manifest);

  mkdirSync(outDir, { recursive: true });
  // Use the same normalized identifier the Solidity generator emits as the
  // library name, so the file name and the `library X {` inside it always agree
  // (e.g. `my-game` → `MyGameTables.sol` containing `library MyGameTables`).
  // Throws a clear error for names that can't form a valid identifier.
  const lib = solidityLibraryName(manifest.name);
  const manifestPath = resolve(outDir, "manifest.json");
  const tablesPath = resolve(outDir, `${lib}.sol`);

  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  writeFileSync(tablesPath, tablesSol);

  return {
    manifest,
    tablesSol,
    outDir,
    files: { manifest: manifestPath, tablesSol: tablesPath },
  };
}

/**
 * Load a `defineGame` module and return its game definition. The module may
 * export the game as `default` or as a named export.
 *
 * `.ts`/`.tsx` sources are loaded in a `tsx` subprocess (so the project's
 * `@nexus/core` and TypeScript are honored) which serializes the definition to
 * JSON on stdout; the GameDefinition is plain data, so the JSON round-trip is
 * lossless. Pre-compiled `.js`/`.mjs` modules are imported directly.
 */
export async function loadGameModule(modulePath: string): Promise<GameDefinition> {
  const abs = resolve(modulePath);
  if (/\.tsx?$/.test(abs)) return loadViaTsx(abs);

  const mod = (await import(pathToFileURL(abs).href)) as Record<string, unknown>;
  const candidates = [mod.default, ...Object.values(mod)];
  for (const candidate of candidates) {
    if (isGameDefinition(candidate)) return candidate;
  }
  throw new Error(
    `No defineGame export found in ${modulePath}. Export your game as default or a named export.`,
  );
}

/** Extractor (ESM) written to a temp .mjs and run with tsx: print the game JSON. */
const EXTRACTOR = `import url from "node:url";
const target = process.argv[2];
const mod = await import(url.pathToFileURL(target).href);
const isGame = (v) =>
  v && typeof v === "object" && typeof v.name === "string" && v.tables && v.systems;
const game = [mod.default, ...Object.values(mod)].find(isGame);
if (!game) {
  console.error("No defineGame export found in " + target);
  process.exit(2);
}
process.stdout.write(JSON.stringify(game));
`;

function loadViaTsx(abs: string): GameDefinition {
  // Place the extractor next to the game module and run with the project as cwd
  // so the module's `@nexus/core` import + tsx both resolve from the project's
  // own node_modules.
  const projectDir = resolve(dirname(abs), "..");
  const scratch = mkdtempSync(resolve(projectDir, ".nexus-codegen-"));
  const extractor = resolve(scratch, "extract.mjs");
  writeFileSync(extractor, EXTRACTOR);
  let out: string;
  try {
    out = execFileSync("npx", ["tsx", extractor, abs], {
      cwd: projectDir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "inherit"],
    });
  } catch (e) {
    throw new Error(
      `Failed to load ${abs} via tsx. Ensure tsx + @nexus/core are installed in the project. (${(e as Error).message})`,
    );
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  const game = JSON.parse(out) as unknown;
  if (!isGameDefinition(game)) {
    throw new Error(`No defineGame export found in ${abs}.`);
  }
  return game;
}

function isGameDefinition(v: unknown): v is GameDefinition {
  if (typeof v !== "object" || v === null) return false;
  const g = v as Partial<GameDefinition>;
  return typeof g.name === "string" && typeof g.tables === "object" && typeof g.systems === "object";
}
