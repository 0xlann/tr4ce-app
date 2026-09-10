import { listVaults } from "../../src/api/client";
import { SearchSurface } from "../../components/evidence/SearchSurface";

/**
 * The comparison surface.
 *
 * A server component so the registry read happens where `TR4CE_API_URL` lives. The policy the user
 * writes, and the evaluation that follows, are the browser's business and go through
 * `/api/evaluate`.
 */

const CHAIN_ID = 8453;

export default async function SearchPage() {
  const vaults = await listVaults(CHAIN_ID);

  return (
    <SearchSurface
      chainId={CHAIN_ID}
      unavailable={vaults.ok ? null : vaults.error.message}
      vaults={vaults.ok ? vaults.value.vaults : []}
    />
  );
}
