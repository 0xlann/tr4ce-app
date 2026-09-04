# TR4CE Smart-Contract Specification

## 1. Decision: no new TR4CE contract in the MVP

TR4CE does not need a protocol contract to produce evidence or prepare ERC-4626 actions. Adding an `ActionRouter`, wrapper vault, or custom custody contract would add approval, audit, and composability risk without improving the core proof.

The MVP interacts directly with verified ERC-20 and ERC-4626 contracts from the user’s wallet. “Smart-contract work” therefore means:

- exact standard interfaces;
- deployment and capability verification;
- transaction construction and simulation;
- fork tests against selected real vaults;
- strict approval and receipt invariants.

A custom contract may be proposed later only for a measured limitation that direct standard calls cannot solve.

## 2. External interfaces

### ERC-20 subset

```solidity
interface IERC20Minimal {
    function balanceOf(address account) external view returns (uint256);
    function allowance(address owner, address spender) external view returns (uint256);
    function approve(address spender, uint256 amount) external returns (bool);
    function decimals() external view returns (uint8);
    function symbol() external view returns (string memory);
}
```

Metadata calls are untrusted and optional for identity. Canonical address and curated chain manifest outrank ticker/name.

### ERC-4626 subset

```solidity
interface IERC4626Minimal is IERC20Minimal {
    function asset() external view returns (address);
    function totalAssets() external view returns (uint256);

    function convertToAssets(uint256 shares) external view returns (uint256 assets);
    function convertToShares(uint256 assets) external view returns (uint256 shares);

    function maxDeposit(address receiver) external view returns (uint256 assets);
    function previewDeposit(uint256 assets) external view returns (uint256 shares);
    function deposit(uint256 assets, address receiver) external returns (uint256 shares);

    function maxWithdraw(address owner) external view returns (uint256 assets);
    function previewWithdraw(uint256 assets) external view returns (uint256 shares);
    function withdraw(
        uint256 assets,
        address receiver,
        address owner
    ) external returns (uint256 shares);

    function maxRedeem(address owner) external view returns (uint256 shares);
    function previewRedeem(uint256 shares) external view returns (uint256 assets);
    function redeem(
        uint256 shares,
        address receiver,
        address owner
    ) external returns (uint256 assets);
}
```

### Events

```solidity
event Deposit(
    address indexed sender,
    address indexed owner,
    uint256 assets,
    uint256 shares
);

event Withdraw(
    address indexed sender,
    address indexed receiver,
    address indexed owner,
    uint256 assets,
    uint256 shares
);
```

TR4CE also indexes standard ERC-20 `Transfer` events on the vault share token, with mint/burn transfers classified so they are not double counted as independent economic flows.

## 3. Read semantics

### `convertToAssets`

Per ERC-4626, this is an idealized average-user conversion. It excludes fees, ignores slippage/limits, is caller-independent, and rounds down. TR4CE uses it for observed share-value history, never as an exact redemption quote.

### `maxWithdraw`

This should not overestimate what the owner can withdraw and may underestimate it. Some deployed protocol versions document non-standard zero behavior. TR4CE stores:

- raw call status and value;
- block number/hash;
- caller/owner argument;
- adapter capability classification;
- reason when the value cannot prove redemption capacity.

### `previewRedeem`

This estimates redemption assets including fees but ignores limits. It must be paired with `maxRedeem`/`maxWithdraw` and an exact simulation.

## 4. Deposit transaction contract

### Inputs

```ts
type PrepareDeposit = {
  chainId: number;
  account: `0x${string}`;
  vault: `0x${string}`;
  asset: `0x${string}`;
  assets: bigint;
  receiver: `0x${string}`;
};
```

### Preconditions

1. Chain is enabled and wallet is connected to `chainId`.
2. Vault is curated and bytecode/capability profile is current.
3. `vault.asset()` equals `asset`.
4. `assets > 0` and is within configured UI/test limits.
5. `balanceOf(account) >= assets`.
6. `maxDeposit(receiver)` supports at least `assets`, or capability semantics are explicitly handled; unsupported limit means no automatic assertion.
7. `previewDeposit(assets)` returns a nonzero expected share amount unless dust behavior is explicitly documented.
8. Exact calldata simulates from `account`.

### Calls

If allowance is insufficient:

```solidity
asset.approve(vault, assets);
```

Then:

```solidity
vault.deposit(assets, receiver);
```

The approval is exact, not unlimited. If a token requires allowance reset, the selected asset adapter must produce the reset transaction explicitly; do not assume USDC behavior across chains.

### Postconditions

- Receipt status is success.
- A matching `Deposit` event exists with expected vault and receiver/owner semantics.
- Actual shares are reported from event/return/receipt evidence, not replaced by preview.
- A failed second transaction leaves the exact allowance visible to the user with a revoke/retry option.

## 5. Redeem transaction contract

### Inputs

```ts
type PrepareRedeem = {
  chainId: number;
  account: `0x${string}`;
  vault: `0x${string}`;
  shares: bigint;
  receiver: `0x${string}`;
  owner: `0x${string}`;
};
```

MVP requires `account == owner == receiver` unless a delegated path is separately specified and tested.

### Preconditions

1. `shares > 0` and `vault.balanceOf(owner) >= shares`.
2. `maxRedeem(owner)` and `maxWithdraw(owner)` are captured with capability status.
3. `previewRedeem(shares)` succeeds.
4. Exact redeem simulates from the owner account.

### Call

```solidity
vault.redeem(shares, receiver, owner);
```

### Postconditions

- Matching `Withdraw` event is decoded.
- Actual assets are taken from execution evidence.
- Preview delta is shown; no “guaranteed output” copy.

## 6. Simulation binding

A valid simulation record is bound to:

```text
chainId
account
transaction.to
transaction.data hash
transaction.value
block number + hash
vault capability version
```

Any change invalidates the simulation. It expires after 3 blocks or 60 seconds, whichever occurs first. The wallet may still expose its own independent simulation; disagreement blocks the TR4CE happy path and shows both contexts.

## 7. Vault onboarding contract tests

Every selected vault must pass a fork-based suite pinned to a declared block.

### Interface tests

- bytecode exists;
- `asset()` returns expected canonical asset;
- decimals are bounded and one-share units do not overflow;
- `totalAssets`, `totalSupply`, and `convertToAssets` return decodable values;
- preview and max methods are classified, including reverts/zeros;
- `Deposit`/`Withdraw` topics match the standard.

### Behavioral tests

- historical `convertToAssets` at start/end blocks reproduces stored snapshots;
- a small deposit from a funded fork account succeeds or is documented as disabled;
- previewed and actual shares obey ERC-4626 direction guarantees;
- a small redemption succeeds or is documented as constrained;
- previewed and actual assets obey direction guarantees;
- deposit above max/simulation limit fails;
- redeem above share balance fails;
- wrong asset identity blocks preparation;
- proxy implementation/code-hash change invalidates capability profile.

Tests do not prove strategy safety. They prove the integration contract used by TR4CE.

## 8. Threat model

| Threat | Control |
|---|---|
| Malicious lookalike vault/token | Curated `(chainId,address)`, code hash, canonical asset manifest |
| Unlimited allowance loss | Exact allowance only; display residual allowance |
| Share-inflation/donation distortion | Label metric correctly, show discontinuity/flows, capability warning |
| Preview manipulation/staleness | Exact simulation, short expiry, wallet confirmation |
| Reentrancy in vault | No TR4CE contract/custody; wallet calls target directly; selected vault risk remains explicit |
| Upgradeable vault changes | Track implementation and bytecode hash per capability version |
| Non-standard token return | viem simulation and asset-specific tested adapter; no generic optimistic decode |
| Wrong chain/account | Bind action and simulation; invalidate on wallet changes |
| Frontend calldata tampering | Recompute/hash in typed action service; show exact target and selector |
| Compromised API | Cannot sign; wallet displays final transaction; CSP/TLS and reproducible calldata |

## 9. Why no multicall/action router

A router could combine approval-adjacent operations or normalize return values, but it would:

- become a new spender/call target;
- require its own authorization and audit;
- weaken the story that TR4CE works directly with the standard;
- make wallet previews less recognizable;
- add no evidence value.

Use public read-only multicall infrastructure for batched reads only after verifying the deployment. State-changing actions stay direct in the MVP.

## 10. Future contract decision gate

A custom contract is justified only if all are true:

1. A required user flow cannot be atomic or safe with direct standard calls.
2. The limitation is demonstrated on selected production contracts.
3. The contract has a minimal privilege model and explicit invariants.
4. Independent review and fork tests fit the release window.
5. The product benefit exceeds the new spender/custody risk.

Likely candidates after MVP: a narrowly scoped permit/deposit helper or governance-approved treasury action guard. Neither is pre-approved.

## 11. Sources

- [ERC-4626 specification](https://eips.ethereum.org/EIPS/eip-4626)
- [ERC-20 specification](https://eips.ethereum.org/EIPS/eip-20)
- [Morpho Vault ERC-4626 mechanics](https://docs.morpho.org/developers/earn/concepts/vault-mechanics/)
- [Morpho vault asset flows](https://docs.morpho.org/developers/earn/tutorials/assets-flow/)
- [viem `simulateContract`](https://viem.sh/docs/contract/simulateContract)
