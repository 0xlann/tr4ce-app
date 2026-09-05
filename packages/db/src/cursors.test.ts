import { describe, expect, it } from "vitest";

import { promotionCeiling } from "./repositories/cursors.js";

/**
 * The promotion bound.
 *
 * This is the single piece of logic that makes the raw/application split work: everything below
 * the ceiling has been written by the sink AND is deep enough that the sink will not undo it, so
 * nothing the sink can still rewrite has ever been promoted. Both bounds are load-bearing and
 * neither implies the other.
 */
describe("promotionCeiling", () => {
  it("uses the confirmed head when the sink has run ahead of it", () => {
    // The sink writes close to chain head. Promoting to its cursor would promote rows still inside
    // the window where a reorg can delete them out from under a report.
    expect(promotionCeiling({ rpcHead: 1000, confirmationDepth: 64, sinkHead: 990 })).toBe(936);
  });

  it("uses the sink head when the sink is behind", () => {
    // The confirmation depth says nothing about what has actually been written. Promoting to
    // rpcHead - depth here would scan blocks the sink has not committed and silently promote
    // nothing for them, then advance past them for good.
    expect(promotionCeiling({ rpcHead: 1000, confirmationDepth: 64, sinkHead: 500 })).toBe(500);
  });

  it("promotes nothing before the sink has written anything", () => {
    expect(promotionCeiling({ rpcHead: 1000, confirmationDepth: 64, sinkHead: null })).toBeNull();
  });

  it("promotes nothing while the chain is shallower than the confirmation depth", () => {
    expect(promotionCeiling({ rpcHead: 10, confirmationDepth: 64, sinkHead: 10 })).toBeNull();
  });

  it("treats a zero depth as promoting straight up to the sink head", () => {
    expect(promotionCeiling({ rpcHead: 1000, confirmationDepth: 0, sinkHead: 990 })).toBe(990);
  });

  it("never returns a block the sink has not written, whatever the depth", () => {
    for (const depth of [0, 1, 12, 64, 256]) {
      const ceiling = promotionCeiling({ rpcHead: 1000, confirmationDepth: depth, sinkHead: 400 });

      expect(ceiling).not.toBeNull();
      expect(ceiling!).toBeLessThanOrEqual(400);
    }
  });

  it("never returns a block inside the unconfirmed window, whatever the sink has written", () => {
    for (const sinkHead of [400, 900, 999, 5000]) {
      const ceiling = promotionCeiling({ rpcHead: 1000, confirmationDepth: 64, sinkHead });

      expect(ceiling).not.toBeNull();
      expect(ceiling!).toBeLessThanOrEqual(1000 - 64);
    }
  });
});
