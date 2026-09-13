import { base } from "wagmi/chains";
import { createConfig, http, type Config } from "wagmi";
import { injected } from "wagmi/connectors";
import { mock } from "wagmi/connectors/mock";

/**
 * The wallet connection, and nothing more.
 *
 * TR4CE never submits a transaction (PRD TR-F-043). The wallet's whole job here is to sign calldata
 * the API prepared and hand back a hash, which the app then reports. That keeps this file small on
 * purpose: no contract writes, no ABI, no reads that the evidence API already answers.
 *
 * **The transport carries no key.** `http()` with no URL falls back to the chain's own public
 * endpoint. The project's real RPC URLs carry an Alchemy key, and anything wagmi needs in the
 * browser would inline that key into the bundle. Nothing on the wallet path needs an authenticated
 * node: status comes from `GET /v1/actions/:id`, and the signing request goes to the wallet's own
 * provider rather than through this transport.
 */

export const CHAIN_ID = base.id;

/**
 * Set to `"mock"` to add wagmi's mock connector, which connects to a fixed address without a wallet
 * extension. `NEXT_PUBLIC_` because a connector is constructed in the browser and there is nowhere
 * else for the flag to live.
 *
 * **Never set this in production.** It would offer visitors a connector that signs nothing and
 * reports hashes for transactions no wallet ever saw. `walletMode()` is exported so a test can
 * assert what the flag does rather than trusting this comment.
 */
export function walletMode(env: Record<string, string | undefined>): "mock" | "injected" {
  return env["NEXT_PUBLIC_TR4CE_WALLET_MODE"] === "mock" ? "mock" : "injected";
}

/** The account the mock connector presents. Only ever reached in `mock` mode. */
export const MOCK_ACCOUNT = "0x1111111111111111111111111111111111111111" as const;

export function createWalletConfig(env: Record<string, string | undefined>): Config {
  const mode = walletMode(env);

  return createConfig({
    chains: [base],
    connectors:
      mode === "mock"
        ? [mock({ accounts: [MOCK_ACCOUNT] })]
        : [injected()],
    transports: { [base.id]: http() },
    ssr: true,
  });
}
