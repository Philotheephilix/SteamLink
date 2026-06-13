import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { createPublicClient, http } from "viem";
import { CliError } from "./log.js";

const FOUNDRY_BIN = `${process.env.HOME}/.foundry/bin`;
const FORGE = `${FOUNDRY_BIN}/forge`;
const ANVIL = `${FOUNDRY_BIN}/anvil`;

const FOUNDRY_INSTALL_HINT =
  "Foundry not found. Install: `curl -L https://foundry.paradigm.xyz | bash && foundryup`";

function foundryEnv(): NodeJS.ProcessEnv {
  return { ...process.env, PATH: `${FOUNDRY_BIN}:${process.env.PATH}` };
}

/** Assert `forge` and `anvil` resolve, else throw the install hint. */
export function requireFoundry(): void {
  try {
    execFileSync(FORGE, ["--version"], { stdio: "ignore", env: foundryEnv() });
    execFileSync(ANVIL, ["--version"], { stdio: "ignore", env: foundryEnv() });
  } catch {
    throw new CliError(FOUNDRY_INSTALL_HINT);
  }
}

export interface ForgeScriptParams {
  /** Foundry project root (cwd for forge). */
  cwd: string;
  /** "script/DeployFull.s.sol:DeployFull" */
  target: string;
  rpcUrl: string;
  privateKey: string;
  /** broadcast (real send). When false runs a simulation only (dry run). */
  broadcast: boolean;
  /** extra env vars passed to the script (PLAYER, ROOM_ID, …). */
  env?: Record<string, string>;
  extraArgs?: string[];
}

/**
 * Build the `forge script` argv. The private key is DELIBERATELY excluded: a
 * value passed as a process argument leaks via `ps`/`/proc/<pid>/cmdline` to any
 * local user. It is instead delivered through the child process environment (see
 * {@link forgeScriptEnv}) and read by the deploy script via
 * `vm.startBroadcast(vm.envUint("PRIVATE_KEY"))`. Pure + exported so the absence
 * of the key in argv is unit-testable.
 */
export function buildForgeScriptArgs(
  p: Pick<ForgeScriptParams, "target" | "rpcUrl" | "broadcast" | "extraArgs">,
): string[] {
  const args = ["script", p.target, "--rpc-url", p.rpcUrl];
  if (p.broadcast) args.push("--broadcast", "--skip-simulation");
  if (p.extraArgs) args.push(...p.extraArgs);
  return args;
}

/**
 * Build the child environment for `forge script`, injecting the deployer key as
 * `PRIVATE_KEY` so forge's env-based signing can pick it up without the key ever
 * appearing in argv. The caller's extra env (ROOM_ID, etc.) is merged in.
 */
export function forgeScriptEnv(
  privateKey: string,
  extra?: Record<string, string>,
): NodeJS.ProcessEnv {
  return { ...foundryEnv(), PRIVATE_KEY: privateKey, ...(extra ?? {}) };
}

/**
 * Invoke `forge script` exactly like scripts/lib/deploy.ts does — same binary,
 * same env-PATH shim, stdio inherited so the forge trace streams to the user.
 * The private key is passed via env (`PRIVATE_KEY`), never as argv, so it does
 * not leak through `ps`.
 */
export function runForgeScript(p: ForgeScriptParams): void {
  const args = buildForgeScriptArgs(p);
  try {
    execFileSync(FORGE, args, {
      cwd: p.cwd,
      stdio: "inherit",
      env: forgeScriptEnv(p.privateKey, p.env),
    });
  } catch (e) {
    throw new CliError(`forge script failed: ${(e as Error).message}`);
  }
}

export interface AnvilOptions {
  chainId?: number;
  port?: number;
  /** Base RPC to fork from (copy-on-read). Omit for a fresh chain. */
  forkUrl?: string;
  /** Pin the fork at a block for determinism. */
  forkBlockNumber?: number;
}

/** Start anvil and resolve once it answers JSON-RPC. */
export async function startAnvil(opts: AnvilOptions = {}): Promise<{
  proc: ChildProcess;
  rpcUrl: string;
  stop: () => void;
}> {
  const port = opts.port ?? 8545;
  const args = ["--silent", "--port", String(port)];
  if (opts.chainId !== undefined) args.push("--chain-id", String(opts.chainId));
  if (opts.forkUrl) args.push("--fork-url", opts.forkUrl);
  if (opts.forkBlockNumber !== undefined)
    args.push("--fork-block-number", String(opts.forkBlockNumber));

  const proc = spawn(ANVIL, args, { env: foundryEnv(), stdio: "ignore" });
  const rpcUrl = `http://127.0.0.1:${port}`;
  const probe = createPublicClient({ transport: http(rpcUrl) });
  const deadline = Date.now() + 15_000;
  for (;;) {
    try {
      await probe.getChainId();
      break;
    } catch {
      if (Date.now() > deadline) {
        proc.kill();
        throw new CliError("anvil did not start within 15s");
      }
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  return { proc, rpcUrl, stop: () => proc.kill() };
}
