import { describe, expect, it } from "vitest";

import { statusPresentation } from "./status-presentation.js";

describe("status presentation", () => {
  it("gives UNKNOWN a visible label and question icon", () => {
    expect(statusPresentation("UNKNOWN")).toEqual({ icon: "?", label: "UNKNOWN" });
  });

  it("does not describe UNKNOWN as zero", () => {
    expect(statusPresentation("UNKNOWN").label).not.toContain("0");
  });
});
