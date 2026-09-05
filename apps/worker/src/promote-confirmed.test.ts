import { describe, expect, it } from "vitest";

import { nextRange } from "./promote-confirmed.js";

const WINDOW_START = 50_577_041;
const MAX = 100_000;

describe("nextRange", () => {
  it("starts a cold run at the manifest window, not at block zero", () => {
    // Scanning from zero would cost a full pass over blocks that were never indexed, to find
    // nothing: the window is the range the manifest actually attests to.
    expect(
      nextRange({
        cursorBlock: null,
        ceiling: WINDOW_START + 500,
        windowStart: WINDOW_START,
        maxBlocksPerRun: MAX,
      }),
    ).toEqual({ fromBlock: WINDOW_START, toBlock: WINDOW_START + 500 });
  });

  it("resumes at the block after the cursor", () => {
    // Inclusive on both ends, so resuming at the cursor itself would re-promote a block every run.
    expect(
      nextRange({
        cursorBlock: WINDOW_START + 100,
        ceiling: WINDOW_START + 500,
        windowStart: WINDOW_START,
        maxBlocksPerRun: MAX,
      }),
    ).toEqual({ fromBlock: WINDOW_START + 101, toBlock: WINDOW_START + 500 });
  });

  it("never returns a block above the ceiling", () => {
    const range = nextRange({
      cursorBlock: null,
      ceiling: WINDOW_START + 10,
      windowStart: WINDOW_START,
      maxBlocksPerRun: MAX,
    });

    expect(range!.toBlock).toBe(WINDOW_START + 10);
  });

  it("caps a cold start at the batch size", () => {
    // A cold start over a month of Base blocks would otherwise build one transaction big enough to
    // hold the whole backfill, and lose all of it on any failure.
    const range = nextRange({
      cursorBlock: null,
      ceiling: WINDOW_START + 1_000_000,
      windowStart: WINDOW_START,
      maxBlocksPerRun: MAX,
    });

    expect(range).toEqual({ fromBlock: WINDOW_START, toBlock: WINDOW_START + MAX - 1 });
  });

  it("returns nothing once the cursor has reached the ceiling", () => {
    expect(
      nextRange({
        cursorBlock: WINDOW_START + 500,
        ceiling: WINDOW_START + 500,
        windowStart: WINDOW_START,
        maxBlocksPerRun: MAX,
      }),
    ).toBeNull();
  });

  it("returns nothing when the ceiling is below the window start", () => {
    // The sink has written, but not yet into the declared window.
    expect(
      nextRange({
        cursorBlock: null,
        ceiling: WINDOW_START - 1,
        windowStart: WINDOW_START,
        maxBlocksPerRun: MAX,
      }),
    ).toBeNull();
  });

  it("covers exactly one block when the ceiling is one ahead of the cursor", () => {
    expect(
      nextRange({
        cursorBlock: WINDOW_START,
        ceiling: WINDOW_START + 1,
        windowStart: WINDOW_START,
        maxBlocksPerRun: MAX,
      }),
    ).toEqual({ fromBlock: WINDOW_START + 1, toBlock: WINDOW_START + 1 });
  });

  it("leaves no gap between consecutive runs", () => {
    // A gap here is unrecoverable in normal operation: the cursor moves past blocks nothing ever
    // read, and the missing observations only surface as an unexplained hole in a report.
    const first = nextRange({
      cursorBlock: null,
      ceiling: WINDOW_START + 250_000,
      windowStart: WINDOW_START,
      maxBlocksPerRun: MAX,
    })!;

    const second = nextRange({
      cursorBlock: first.toBlock,
      ceiling: WINDOW_START + 250_000,
      windowStart: WINDOW_START,
      maxBlocksPerRun: MAX,
    })!;

    expect(second.fromBlock).toBe(first.toBlock + 1);
  });
});
