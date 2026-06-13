import { describe, expect, it } from "vitest";
import { buildForgeScriptArgs, forgeScriptEnv } from "../src/lib/foundry.js";

const SECRET = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";

describe("buildForgeScriptArgs (M8: key not in argv)", () => {
  it("never places the private key in the forge argv", () => {
    const args = buildForgeScriptArgs({
      target: "script/DeployFull.s.sol:DeployFull",
      rpcUrl: "http://127.0.0.1:8545",
      broadcast: true,
    });
    // The key must not appear anywhere in argv, and the leaking flag is gone.
    expect(args).not.toContain("--private-key");
    expect(args.some((a) => a.includes(SECRET))).toBe(false);
    expect(args.join(" ")).not.toContain(SECRET);
    // It still builds a real forge script invocation.
    expect(args.slice(0, 2)).toEqual(["script", "script/DeployFull.s.sol:DeployFull"]);
    expect(args).toContain("--rpc-url");
    expect(args).toContain("--broadcast");
  });

  it("delivers the key through the child env instead", () => {
    const env = forgeScriptEnv(SECRET, { ROOM_ID: "1" });
    expect(env.PRIVATE_KEY).toBe(SECRET);
    expect(env.ROOM_ID).toBe("1");
  });
});
