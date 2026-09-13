import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * The acceptance clause, second half: "without ... transaction submission."
 *
 * A deliberate copy of `apps/api/src/no-signing.test.ts`, over this app's sources. The API's copy
 * cannot reach these files, and a shared list would have to live in a non-test module — where the
 * API's own scan would then find the forbidden words and fail on the list itself.
 *
 * Read from source rather than inferred from types, for the same reason as its sibling: a wallet
 * client constructed at runtime type-checks perfectly well, and the property being asserted is
 * about what the code can do, not about what its signatures say.
 */

const root = join(dirname(fileURLToPath(import.meta.url)));

const forbidden = [
  "createWalletClient",
  "walletClient",
  "sendTransaction",
  "sendRawTransaction",
  "writeContract",
  "privateKeyToAccount",
  "mnemonicToAccount",
  "signTransaction",
  "signTypedData",
  "PRIVATE_KEY",
];

function sources(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);

    if (statSync(path).isDirectory()) {
      return sources(path);
    }

    return name.endsWith(".ts") && !name.endsWith(".test.ts") ? [path] : [];
  });
}

describe("the MCP server cannot sign or submit", () => {
  const files = sources(root);

  it("has files to check", () => {
    // Without this, a broken path would make every assertion below vacuously true.
    expect(files.length).toBeGreaterThan(1);
  });

  for (const file of files) {
    it(`${file.slice(root.length + 1)} reaches for no signing or submitting API`, () => {
      // Comments stripped: the prose in these files necessarily names the very things it forbids.
      const code = readFileSync(file, "utf8")
        .replaceAll(/\/\*[\s\S]*?\*\//g, "")
        .replaceAll(/\/\/[^\n]*/g, "");

      for (const pattern of forbidden) {
        expect(code, `${file} names ${pattern}`).not.toContain(pattern);
      }
    });
  }
});
