import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * Task 7's acceptance clause, first half: "There is no service method that signs or submits."
 *
 * @tr4ce/chain has its own version of this check over the calldata layer. This one covers the
 * services and routes, which is where the clause actually points — a route could reach for a wallet
 * without the chain package ever knowing.
 *
 * Read from source rather than inferred from types. A wallet client constructed at runtime
 * type-checks perfectly well, and the property being asserted is about what the code can do, not
 * about what its signatures say.
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

describe("the API cannot sign or submit", () => {
  const files = sources(root);

  it("has files to check", () => {
    // Without this, a broken path would make every assertion below vacuously true.
    expect(files.length).toBeGreaterThan(5);
  });

  for (const file of files) {
    it(`${file.slice(root.length + 1)} reaches for no signing or submitting API`, () => {
      // Comments stripped: the prose in these files necessarily names the very things it forbids.
      const code = readFileSync(file, "utf8")
        .replaceAll(/\/\*[\s\S]*?\*\//g, "")
        .replaceAll(/\/\/[^\n]*/g, "");

      for (const api of forbidden) {
        expect(code).not.toContain(api);
      }
    });
  }
});
