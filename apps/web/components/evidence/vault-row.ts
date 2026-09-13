import type { VaultSummary } from "@tr4ce/domain";

/**
 * One row of the comparison, before a policy has been applied to it.
 *
 * The registry half of `GET /v1/vaults`. Kept as a named type rather than inlined because the page,
 * the sort and the table all take it, and the shape is the API's rather than ours to invent.
 */
export type VaultRow = VaultSummary;
