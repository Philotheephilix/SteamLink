#!/usr/bin/env node
/**
 * `nexus` CLI entry point — the developer's command surface over the SDK. Wires
 * the Commander program to the subcommands in ./commands: `init` (scaffold a
 * project), `codegen` (emit Solidity tables + TS types from `defineGame`),
 * `deploy` (deploy the World/systems to Base via Foundry), `dev` (local devnet),
 * `migrate` (register/upgrade systems), and `fork` (fork a chain for testing).
 */
import { Command } from "commander";
import { codegenCommand } from "./commands/codegen.js";
import { deployCommand } from "./commands/deploy.js";
import { devCommand } from "./commands/dev.js";
import { forkCommand } from "./commands/fork.js";
import { initCommand } from "./commands/init.js";
import { migrateCommand } from "./commands/migrate.js";
import { CliError, log } from "./lib/log.js";

const program = new Command();

program
  .name("nexus")
  .description("Nexus game engine SDK — scaffold, codegen, deploy, and run games on Base.")
  .version("0.0.0");

program
  .command("init")
  .description("scaffold a new game project (tables + systems + config)")
  .argument("<name>", "project directory name (lower-kebab/snake)")
  .action((name: string) => {
    initCommand(name);
  });

program
  .command("codegen")
  .description("generate the Solidity tables library + manifest.json from a defineGame module")
  .option("--game <path>", "path to the defineGame module", "game/game.ts")
  .option("--out <dir>", "output directory", "nexus.generated")
  .action(async (opts: { game?: string; out?: string }) => {
    await codegenCommand({ game: opts.game, out: opts.out });
  });

program
  .command("deploy")
  .description("deploy World + systems + enforcers from the manifest (forge script)")
  .requiredOption("--network <network>", "target network: base | base-sepolia")
  .option("--manifest <path>", "path to manifest.json", "nexus.generated/manifest.json")
  .option("--contracts <dir>", "foundry project root with the deploy script")
  .option("--script <target>", "forge script target (Contract:Function)")
  .option("--dry-run", "simulate + print the plan, deploy nothing", false)
  .option("--yes", "skip the confirmation prompt (CI)", false)
  .action((opts: Record<string, unknown>) => {
    deployCommand({
      network: opts.network as string,
      manifest: opts.manifest as string,
      contracts: opts.contracts as string | undefined,
      script: opts.script as string | undefined,
      dryRun: Boolean(opts.dryRun),
      yes: Boolean(opts.yes),
    });
  });

program
  .command("dev")
  .description("boot a local Base fork + the full stack (zero credentials)")
  .option("--port <n>", "gateway port", (v) => Number.parseInt(v, 10), 8080)
  .option("--fork-rpc <url>", "Base RPC to fork from")
  .option("--block <n>", "pin the fork at a block", (v) => Number.parseInt(v, 10))
  .option("--no-fork", "use a fresh local chain instead of forking Base")
  .option("--dry-run", "print the plan without spawning anything", false)
  .action(async (opts: Record<string, unknown>) => {
    await devCommand({
      port: opts.port as number,
      forkRpc: opts.forkRpc as string | undefined,
      block: opts.block as number | undefined,
      noFork: opts.fork === false,
      dryRun: Boolean(opts.dryRun),
    });
  });

program
  .command("migrate")
  .description("upgrade system logic without touching stored tables (re-codegen + repoint)")
  .requiredOption("--network <network>", "target network: base | base-sepolia")
  .option("--only <systems>", "comma-separated system names to upgrade")
  .option("--contracts <dir>", "foundry project root")
  .option("--script <target>", "forge script target")
  .option("--dry-run", "print the upgrade plan, deploy nothing", false)
  .option("--yes", "skip confirmation (CI)", false)
  .action(async (opts: Record<string, unknown>) => {
    await migrateCommand({
      network: opts.network as string,
      only: opts.only ? (opts.only as string).split(",").map((s) => s.trim()) : undefined,
      contracts: opts.contracts as string | undefined,
      script: opts.script as string | undefined,
      dryRun: Boolean(opts.dryRun),
      yes: Boolean(opts.yes),
    });
  });

program
  .command("fork")
  .description("clone live Base state into a local staging fork (anvil --fork-url)")
  .option("--from <network>", "source network: base | base-sepolia", "base")
  .option("--at <block>", "block to snapshot at", (v) => Number.parseInt(v, 10))
  .option("--port <n>", "staging RPC port", (v) => Number.parseInt(v, 10), 8546)
  .option("--fork-rpc <url>", "Base RPC to fork from")
  .option("--dry-run", "print the plan without spawning anything", false)
  .action(async (opts: Record<string, unknown>) => {
    await forkCommand({
      from: opts.from as string,
      at: opts.at as number | undefined,
      port: opts.port as number,
      forkRpc: opts.forkRpc as string | undefined,
      dryRun: Boolean(opts.dryRun),
    });
  });

async function main(): Promise<void> {
  try {
    await program.parseAsync(process.argv);
  } catch (e) {
    if (e instanceof CliError) {
      log.fail(e.message);
      process.exitCode = 1;
      return;
    }
    throw e;
  }
}

void main();
