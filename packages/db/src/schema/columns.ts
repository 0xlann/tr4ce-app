import { customType } from "drizzle-orm/pg-core";

/**
 * PostgreSQL `bytea`.
 *
 * ERD section 9 stores every address and hash as raw bytes and serialises checksummed hex only at
 * application boundaries. Raw staging keeps them as `0x` text because that is what the Database
 * Changes sink emits; the promotion worker converts once, here.
 */
export const bytea = customType<{ data: Uint8Array; driverData: Uint8Array }>({
  dataType() {
    return "bytea";
  },
});

const hexPattern = /^0x[0-9a-fA-F]*$/;

/**
 * Decode `0x`-prefixed hex into bytes.
 *
 * Casting the text straight to `bytea` in SQL is the trap this exists to avoid: PostgreSQL either
 * rejects it or stores the ASCII of the hex string, which is wrong data rather than a failure.
 */
export function hexToBytes(hex: string): Uint8Array {
  if (!hexPattern.test(hex)) {
    throw new TypeError(`Expected 0x-prefixed hex, received ${JSON.stringify(hex)}`);
  }

  const body = hex.slice(2);

  if (body.length % 2 !== 0) {
    throw new TypeError(`Hex payload has an odd number of digits: ${JSON.stringify(hex)}`);
  }

  const bytes = new Uint8Array(body.length / 2);

  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(body.slice(index * 2, index * 2 + 2), 16);
  }

  return bytes;
}

/** Encode bytes as lowercase `0x` hex. Checksumming happens at the API boundary, not here. */
export function bytesToHex(bytes: Uint8Array): string {
  let hex = "0x";

  for (const byte of bytes) {
    hex += byte.toString(16).padStart(2, "0");
  }

  return hex;
}

/** Byte-wise equality; `Uint8Array` has no useful `===`. */
export function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) {
    return false;
  }

  return left.every((byte, index) => byte === right[index]);
}
