---
name: tr4ce-vault-evidence
description: Reproducible evidence about ERC-4626 vaults on Base, evaluated against an explicit policy, with unsigned transactions the wallet owner must approve. Use when asked to compare vaults, check whether a vault meets stated criteria, explain where a yield or TVL figure came from, or prepare a deposit or redemption. Not a source of yield predictions.
---

# TR4CE — verifiable vault evidence

TR4CE answers one kind of question: **what did this vault actually do, and can you show me?**

Every number it returns is traceable to a named block and a recorded call. It does not forecast, it
does not rank by APY, and it never sends a transaction.

## The one rule that matters most

**TR4CE prepares transactions. It never signs or submits them.** `prepare_deposit` and
`prepare_redeem` return unsigned calldata plus a simulation. Getting a result from them means
nothing has happened on chain. The wallet owner must review and approve every call in their own
wallet.

Never tell a user a deposit or redemption is complete because a prepare tool succeeded. It is not.

## Tools

| Tool | Use it to |
|---|---|
| `search_vaults` | Find the vaults TR4CE has verified, with their asset and decimals. Start here. |
| `get_evidence` | Get the immutable report for a vault over a window, with a policy evaluated against it. |
| `evaluate_policy` | Try a candidate policy against current evidence without storing anything. |
| `prepare_deposit` | Build the unsigned approval and deposit calls, simulated at a pinned block. |
| `prepare_redeem` | Build the unsigned redeem call, simulated at a pinned block. |
| `get_action_status` | Ask whether a prepared action may still be signed, and what the receipt said. |

A normal flow is `search_vaults` → `get_evidence` → (`prepare_deposit` if the user asks to act) →
`get_action_status`.

### These tools are not read-only

`get_evidence` records the report it produces, and the prepare tools record the action and its
simulation. That is what makes a report citable by identifier afterwards.

What they never do is change state on a blockchain or move funds. When the integrations
specification calls them side-effect-free, that is what it means. There is no tool here that
submits a transaction, and there is no hidden one.

Both writes are idempotent. A report's identifier is derived from the observations it cites, so
asking the same question twice returns the same report rather than a second one. The response says
`created: true` the first time and `created: false` afterwards.

### `get_evidence` needs a policy

There is no way to ask for evidence without one: the report contract makes the policy evaluation a
required part of a report, so `get_evidence` takes all five rules.

**Ask the user for their criteria rather than inventing them.** A report produced against thresholds
you made up carries a `status` verdict about numbers nobody asked for, and presenting that verdict
is an unsupported claim even when every observation in it is correct. If the user only wants to know
what a vault did, you may still state the observations — the blocks, the share values, the TVL — and
say that the pass/fail verdict is against criteria you were given, or say you need criteria first.

## Units

**Every token amount is an integer in base units, encoded as a decimal string.** Never a float,
never a JSON number.

- USDC has 6 decimals. `"1000000"` is 1 USDC. `"2000000000000"` is 2,000,000 USDC.
- Share amounts use the vault's own `shareDecimals`, which `search_vaults` returns per vault. Do not
  assume it matches the asset's.
- Block numbers are decimal strings for the same reason.
- Basis points are integers. 25 bps is 0.25%.
- Timestamps are ISO-8601 UTC strings.

When you show a number to a user, convert it and say the unit. When you pass one back to a tool,
pass the base-unit string unchanged. Multiplying by `10 ** decimals` in floating point will corrupt
large amounts; build the string instead.

## PASS, FAIL, and UNKNOWN

Each policy rule returns one of three verdicts, and the third is not a soft failure.

- **PASS** — the rule was checked against evidence and the evidence met it.
- **FAIL** — the rule was checked against evidence and the evidence did not meet it.
- **UNKNOWN** — the observation the rule needed was not available. The vault did not answer a call,
  the window has no snapshot at one end, or the method is non-standard for this vault.

**UNKNOWN must never be reported as FAIL, and never as PASS.** Say what is missing. "This vault's
withdrawal limit could not be read at that block, so the withdrawable-assets rule is unknown" is the
correct answer. "This vault fails the withdrawal check" is not.

An overall report status of `unknown` means at least one rule was unknown. It is not a verdict on
the vault.

## What the evidence does and does not cover

- **The window is a request, not a guarantee.** Asking for 30 days returns the elapsed time actually
  measured, which may be shorter if the vault has less history or if the earliest usable snapshot is
  later than requested. Read `actualElapsedSeconds`, not the window you asked for.
- **Returns are observed, not predicted.** An observed share-value change over a past window says
  what happened between two blocks. It is not an APY, it is not annualised, and it does not
  continue. Never present it as a forecast or a rate a user will earn.
- **Reports are pinned to a block.** They do not update. Ask again for a newer one.
- **Limitations stay attached.** If a report carries reason codes or capability warnings, they are
  part of the answer, not footnotes to drop.
- **Nothing is filled in.** A value TR4CE could not observe is `null`, never zero and never a
  substitute drawn from somewhere else. `null` means "we did not see it".
- **Only verified vaults.** `search_vaults` returns vaults with a recorded source and verification
  block. TR4CE will not report on an arbitrary address.

## Preparing an action

A deposit is often **two** transactions: an exact approval, then the deposit. The approval is always
for the exact amount — TR4CE never requests an unlimited allowance. `transactions` comes back as an
array in signing order, each entry naming its `kind`.

The second call cannot be simulated until the first has landed, because it would revert for want of
the allowance. So the sequence is:

1. `prepare_deposit` — returns both calls, the first one simulated.
2. The user signs call 0 in their wallet.
3. `get_action_status` — reports `signable: false` with reason `NOT_SIMULATED`, because the deposit
   has not been simulated yet.
4. The application resimulates, then the user signs call 1.

A simulation expires after **3 blocks or 60 seconds, whichever comes first**. On Base the block
bound almost always fires first. An expired action is not broken; it needs resimulating.

`get_action_status` names why an action is not signable: `SIMULATION_FAILED` (the chain refused it),
`NOT_SIMULATED` (nobody has asked yet), `BLOCK_BUDGET_SPENT` or `TIME_BUDGET_SPENT` (expired). These
call for different things and should be reported differently.

For a redemption, the amount is in **shares**, not assets. A vault's `maxRedeem` can sit fractionally
below the owner's own share balance, so "redeem everything" built from `balanceOf` may be refused.
Use the limit the evidence reports.

## Errors

Every failure returns the same envelope, and the tool result is marked as an error:

```json
{ "error": { "code": "ACTION_NOT_AVAILABLE", "message": "...", "reasonCodes": [], "issues": [] } }
```

Read `code` and relay `message`. Some worth recognising:

- `UNKNOWN_VAULT` — not in the verified registry. Do not substitute a similar address.
- `INSUFFICIENT_OBSERVATIONS` — the window has no usable snapshot. Try a shorter window.
- `ACTION_NOT_AVAILABLE` — the chain will not accept this action right now; `message` says why.
- `INVALID_REQUEST` — `issues` names the fields.

An invalid policy sent to `evaluate_policy` is **not** an error. It returns `issues` describing what
is wrong, so a user can fix a draft.

## Examples

**Good.** "Over the 7 days ending at block 50,879,900, this vault's share value rose 1.0%, from
1.000000 to 1.010000 USDC per share. TVL at that block was 417,000 USDC. That is what happened in
that window; it is not a rate of return going forward. The withdrawal-limit rule is UNKNOWN because
the vault did not answer `maxWithdraw` at that block."

**Wrong.** "This vault yields 52% APY." — Annualising an observed window is a forecast, and TR4CE
does not produce one.

**Wrong.** "All checks passed." — when a rule was UNKNOWN. Say which one and why.

**Wrong.** "I've deposited 1,000 USDC for you." — TR4CE cannot deposit. It prepared calls the user
must approve in their wallet.

**Good.** "I've prepared two transactions: an approval for exactly 1,000 USDC, then the deposit. The
simulation succeeded at block 50,879,900 and is valid for about 6 seconds or 3 blocks. Review and
approve them in your wallet — nothing has been sent."
