import { expect, it } from "vitest";

import { formatUsdcMillions } from "./display.js";

it("formats six-decimal base units as USDC millions without floating point", () => {
  expect(formatUsdcMillions("4200000000000")).toBe("4.20m USDC");
});
