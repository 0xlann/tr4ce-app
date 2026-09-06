import type { PolicyPreset } from "../../src/demo/types";

export type HeroState = { preset: PolicyPreset };
export type HeroEvent = { type: "SELECT_PRESET"; preset: PolicyPreset };

export const initialHeroState: HeroState = { preset: "balanced" };

export function reduceHeroState(_: HeroState, event: HeroEvent): HeroState {
  return { preset: event.preset };
}
