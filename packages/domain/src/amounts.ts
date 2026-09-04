import { z } from "zod";

const unsignedDecimalPattern = /^(0|[1-9][0-9]*)$/;
const signedDecimalPattern = /^-?(0|[1-9][0-9]*)$/;

export const baseUnitStringSchema = z
  .string()
  .regex(unsignedDecimalPattern, "Expected a non-negative integer decimal string")
  .brand<"BaseUnitString">();
export type BaseUnitString = z.infer<typeof baseUnitStringSchema>;

export const signedBaseUnitStringSchema = z
  .string()
  .regex(signedDecimalPattern, "Expected an integer decimal string")
  .brand<"SignedBaseUnitString">();
export type SignedBaseUnitString = z.infer<typeof signedBaseUnitStringSchema>;

export const basisPointsSchema = z.number().int().safe().brand<"BasisPoints">();
export type BasisPoints = z.infer<typeof basisPointsSchema>;

export type BaseUnits = bigint & { readonly __brand: "BaseUnits" };

export function parseBaseUnits(value: BaseUnitString): BaseUnits {
  return BigInt(value) as BaseUnits;
}

export function serializeBaseUnits(value: BaseUnits): BaseUnitString {
  if (value < 0n) {
    throw new RangeError("Base units cannot be negative");
  }

  return baseUnitStringSchema.parse(value.toString());
}
