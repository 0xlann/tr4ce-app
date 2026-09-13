import { describe, expect, it } from "vitest";

import { initialHeroState, reduceHeroState } from "./hero-state.js";

describe("hero policy control", () => {
  it("changes the active preset when a user chooses strict", () => {
    expect(reduceHeroState(initialHeroState, { type: "SELECT_PRESET", preset: "strict" }).preset).toBe("strict");
  });
});
