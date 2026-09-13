"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";
import { WagmiProvider } from "wagmi";

import { createWalletConfig } from "../../src/wallet/config";

/**
 * wagmi and its query client, mounted once around the tree.
 *
 * Both are built inside `useState` rather than at module scope. A module-level config is shared by
 * every request the server handles, and on the server that means one visitor's connection state
 * could be handed to the next. Building per mount keeps it per browser.
 *
 * `process.env` is read here rather than passed down: Next inlines `NEXT_PUBLIC_` values at build
 * time, and the read has to be a literal member access for that substitution to happen at all.
 */

export function WalletProvider({ children }: { children: React.ReactNode }) {
  const [config] = useState(() =>
    createWalletConfig({
      NEXT_PUBLIC_TR4CE_WALLET_MODE: process.env.NEXT_PUBLIC_TR4CE_WALLET_MODE,
    }),
  );
  const [queryClient] = useState(() => new QueryClient());

  return (
    <WagmiProvider config={config}>
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    </WagmiProvider>
  );
}
