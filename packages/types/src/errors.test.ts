import { describe, expect, it } from "vitest";
import { NexusError, codeFromRevert } from "./errors.js";

describe("NexusError", () => {
  it("carries code and default retryability", () => {
    const e = new NexusError("RELAYER_FAILED", "boom");
    expect(e.code).toBe("RELAYER_FAILED");
    expect(e.retryable).toBe(true);
    expect(NexusError.is(e)).toBe(true);
    expect(NexusError.has(e, "RELAYER_FAILED")).toBe(true);
    expect(NexusError.has(e, "NOT_YOUR_TURN")).toBe(false);
  });

  it("non-retryable codes default to retryable=false", () => {
    expect(new NexusError("NOT_YOUR_TURN", "x").retryable).toBe(false);
  });

  it("instanceof survives across the prototype fix", () => {
    const e: unknown = new NexusError("INTERNAL", "x");
    expect(e instanceof NexusError).toBe(true);
  });
});

describe("codeFromRevert", () => {
  it("maps known enforcer reverts", () => {
    expect(codeFromRevert("TurnBoundEnforcer: NotYourTurn()")).toBe("NOT_YOUR_TURN");
    expect(codeFromRevert("PerActionCap exceeded")).toBe("BUDGET_EXCEEDED");
    expect(codeFromRevert("SystemNotAllowed()")).toBe("SYSTEM_NOT_ALLOWED");
    expect(codeFromRevert("delegation expired")).toBe("DELEGATION_EXPIRED");
    expect(codeFromRevert("0xdeadbeef unknown")).toBe("INTERNAL");
  });
});
