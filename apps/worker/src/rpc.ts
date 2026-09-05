/**
 * The two chain reads promotion needs, over plain JSON-RPC.
 *
 * Deliberately minimal. `packages/chain` (Task 7) owns the real client with viem, ABI decoding,
 * simulation, and receipt handling; pulling that in here would invert the dependency — the worker
 * would wait on the action layer to promote history it already has.
 */

interface JsonRpcResponse<T> {
  result?: T;
  error?: { code: number; message: string };
}

async function call<T>(url: string, method: string, params: unknown[]): Promise<T> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });

  if (!response.ok) {
    throw new Error(`${method} failed: HTTP ${response.status} ${response.statusText}`);
  }

  const body = (await response.json()) as JsonRpcResponse<T>;

  if (body.error !== undefined) {
    throw new Error(`${method} failed: ${body.error.message} (${body.error.code})`);
  }

  if (body.result === undefined) {
    throw new Error(`${method} returned no result.`);
  }

  return body.result;
}

/** Latest block the provider will answer for. The promotion ceiling is measured down from this. */
export async function getBlockNumber(url: string): Promise<number> {
  const hex = await call<string>(url, "eth_blockNumber", []);

  return Number.parseInt(hex, 16);
}

/**
 * The canonical hash at a block number, or null if the provider does not have that block.
 *
 * This is the whole basis of deep-reorg detection: a promoted row whose block hash no longer
 * matches the hash the chain reports at that height was promoted from a block that no longer
 * exists.
 */
export async function getBlockHash(url: string, blockNumber: number): Promise<string | null> {
  const block = await call<{ hash: string } | null>(url, "eth_getBlockByNumber", [
    `0x${blockNumber.toString(16)}`,
    false,
  ]);

  return block === null ? null : block.hash.toLowerCase();
}
