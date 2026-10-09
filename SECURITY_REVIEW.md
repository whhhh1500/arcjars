# ArcJars security review

**Scope:** `contracts/src/ArcJar.sol` and `contracts/src/ArcJarFactory.sol` (baseline commit `7507f80`), plus the security-relevant parts of the dApp (`app/src`), the keeper and `scripts/deploy_mainnet.sh`.
**Method:** manual line-by-line review against Arc's documented EVM differences (native 18-decimal USDC with a 6-decimal ERC-20 view of the same balance, value-transfer rules, blocklist, Memo/CallFrom, Osaka baseline), followed by Foundry unit, fuzz and invariant tests, an end-to-end run on an `arc-anvil` fork of Arc testnet, and a headless-browser UI test.
**Result:** no critical or high-severity issues. One medium and two low issues in the contracts, and two medium and four low issues in the app. All are fixed and covered by tests. The remaining items are informational design notes.

> This is an independent internal review, not a professional audit. Treat the contracts as unaudited and use small amounts.

## Summary

| ID | Severity | Component | Title | Status |
|---|---|---|---|---|
| C-M1 | Medium | ArcJar | Non-USDC tokens sent to a jar (EURC, cirBTC, WETH…) are stuck forever | Fixed |
| C-L1 | Low | ArcJar / Factory | Single-step ownership transfer, and the factory registry goes stale after a transfer | Fixed |
| C-L2 | Low | ArcJar | `dest` can be set to the jar itself, which bricks that jar's withdrawals | Fixed |
| A-M1 | Medium | App | Unescaped RPC error text rendered as HTML (XSS reachable via `?rpc=`) | Fixed |
| A-M2 | Medium | App | Link-controlled `?factory=` / `?rpc=` overrides are silent; a phishing link can make a user create a jar from a hostile factory | Fixed (warning + no "verified" badge under overrides) |
| A-L1 | Low | App | Reverted transactions reported as success (receipt status ignored) | Fixed |
| A-L2 | Low | App | A Memo payment that moved no USDC was still reported as paid | Fixed |
| A-L3 | Low | App | Jar names longer than 31 UTF-8 bytes (about 11 or more Chinese characters) and negative or invalid percentages crash `createJar` encoding | Fixed |
| A-L4 | Low | App | Typing more than a jar's balance silently withdrew the whole jar | Fixed |
| I-1 … I-12 | Info | — | Double-count, reentrancy, rounding, fee cap, locks, init front-running, griefing, gas: verified safe, with notes | Tests added |

---

## Contract findings

### C-M1: Non-USDC tokens sent to a jar are permanently stuck (Medium)

Arc mainnet hosts other Circle and bridged ERC-20s (EURC `0xbEf5…21c1`, cirBTC, WETH, USYC). A payer who sends EURC to a pay link, an easy mistake because EURC is "the other Circle stablecoin", loses it. `sweep()` only accounts for the native balance, and no function can move an arbitrary ERC-20.

**Fix:** `rescueToken(token, to, amount)`, owner-only and `nonReentrant`.
* It rejects `token == 0x3600…0000` (the USDC ERC-20 interface), `address(0)` and code-less addresses (`ProtectedToken`).
* As a **chain-agnostic backstop**, the call reverts with `NativeBalanceMoved` if `address(this).balance` decreased during the transfer. No token that is a view of the native balance can ever be used to pull USDC out around the jar accounting or the **time locks**.

**Tests:** `test_RescueForeignToken`, `test_RescueCannotTouchUsdc`, `test_RescueRevertsIfNativeBalanceMoves` (a mock token that moves native balance like Arc's USDC interface does). On the Arc testnet fork, `rescueToken(0x3600…)` reverts with `ProtectedToken()` (`deployments/e2e-arc-testnet-fork.log`, step 9).

### C-L1: Single-step ownership, and the registry goes stale (Low)

`transferOwnership(newOwner)` took effect at once. A typo'd address permanently strands every jar balance, including time-locked tax money. Also, `factory.jarsOf()` never learned about the new owner, so the new owner couldn't find the jar in the app.

**Fix:**
* Two-step transfer: `transferOwnership` sets `pendingOwner` (`address(0)` cancels), and `acceptOwnership()` completes it.
* On acceptance the jar calls `factory.recordOwnerChange(previous, new)`. The factory only accepts the call from jars it deployed (`isJar`), and because the new owner must accept, nobody can spam someone else's `jarsOf` list.
* `jarsOf` stays append-only, and the app filters by the live `owner()`.

**Tests:** `test_TransferOwnershipIsTwoStep`, `test_TransferOwnershipCancel`, `test_OwnershipTransferKeepsLocks` (a new owner still can't open a locked jar early), `test_RegistryRejectsNonJars`, `test_ImplementationCannotAcceptOwnership`. Also confirmed on the Arc testnet fork (e2e step 9).

### C-L2: `dest == address(this)` bricks a jar's withdrawals (Low)

`withdraw` correctly refuses to pay the jar itself, but `addJar` and `setDest` accepted that destination, so every withdrawal from that jar reverted until the owner noticed and changed it. The owner could recover, so no funds were at risk.

**Fix:** both functions revert with `BadDest`. **Test:** `test_RevertDestIsJarItself`.

---

## Informational: areas reviewed and found safe

**I-1: Native/ERC-20 double count (main Arc-specific risk). Safe.**
`receive()` splits exactly `msg.value` and adds it to `allocated`. `sweep()` splits only `address(this).balance − allocated`, which is precisely what arrived **without running code**: ERC-20 `transfer`/`transferFrom` on `0x3600…`, Memo payments (CallFrom → ERC-20), `SELFDESTRUCT` / EIP-6780 force-sends, and payments to a predicted address made before the jar existed. A native payment can therefore never be swept a second time, and an ERC-20 arrival is split exactly once. All accounting is in 18-decimal native units, so the 6-decimal view never enters the math.
New tests:
* `testFuzz_NoDoubleSplit` (1,000 runs): random interleavings of native and ERC-20 payments, asserting `unallocated == unswept ERC-20` after every step and `allocated == total in` at the end.
* `invariant_NoDoubleCountNoLoss` (ghost accounting): `unallocated == ghostUnswept`, `balance == ghostIn − ghostOut`, `allocated + unswept == balance`.
* `test_SweepAfterSelfDestructForceSend`.

**I-2: Reentrancy. Safe.**
`withdraw`, `sweep`, `collectFees` and `rescueToken` are `nonReentrant` (transient-storage guard; Arc targets Osaka, so EIP-1153 is available) and follow checks-effects-interactions. `receive()` is intentionally unguarded so a payout recipient can pay back in. That is safe because state is fully updated before `_send`, and re-entering `receive` only adds `msg.value` to both the balance and `allocated`. New test: `test_ReenterReceiveDuringWithdraw`. The existing tests attack all three external-call paths.

**I-3: Rounding and dust. Safe.**
Each jar *i ≥ 1* gets `floor(net × bps_i / 10 000)`, and Spendable gets `net − Σ`, so jars always sum to `net` exactly (`testFuzz_SplitSumsExactly`, `test_DustGoesToSpendable`). The fee rounds down. Payments under 5,000 wei (5e-15 USDC) pay no fee, which is irrelevant economically because gas costs far more. `sweep()` charges the fee once on the aggregate, so many small ERC-20 payments swept together pay at most 1 USDC in total. That favors users, at a small revenue cost.

**I-4: Fee cap across decimals. Correct.**
`FEE_CAP = 1e18` native units = 1 USDC. ERC-20 arrivals are measured through the native balance (`6-dec × 1e12`), so the cap is identical on both paths (`test_FeeCapSameForErc20AndNative`, `test_FeeCappedAtOneUsdc`). `MAX_FEE_BPS = 20` is a constant, and `feeBps` is an immutable of the implementation.

**I-5: Lock bypass. None found.**
Paths checked:
* `withdraw` enforces `block.timestamp < unlockAt`.
* `extendLock` only moves the lock forward (≤ 10 years).
* `setSplits` and `addJar` affect future income only.
* `setDest` changes where a jar pays out, not when.
* Ownership transfer keeps locks (`test_OwnershipTransferKeepsLocks`).
* `rescueToken` can't touch native USDC (C-M1).
* No function moves balances between jars.

Note: Arc block timestamps come from the proposer's clock and are non-decreasing, so expect second-level precision. Note: `dest` is a convenience, not a security boundary: the owner can change it during a lock.

**I-6: Factory and clone initialization front-running. Safe.**
`createJar` clones and initializes in the same call. The CREATE2 salt is `keccak(owner, salt)`, so nobody else can deploy at (or front-run) a user's predicted address. The implementation is locked (`owner = 0xdead`), so `initialize` and `acceptOwnership` on it revert. New test: `test_FrontRunCreateCannotHijackPredictedAddress` (money paid to a predicted address before creation becomes sweepable by the rightful owner).

**I-7: Griefing via `receive()`. A payer never loses funds.**
Every failure in `receive()` reverts the whole transaction, so the payer keeps the USDC (only gas is spent):
* too little gas, including a 2,300-gas stipend or a fixed 21,000-gas exchange withdrawal (`test_LowGasNativePaymentRevertsSafely`, and confirmed on the real testnet node);
* paying the bare implementation (`test_PaymentToImplementationReverts`).

Payout failures (a blocklisted or reverting recipient) revert and leave balances intact (`test_RevertWithdrawToRejectingReceiver`). Nobody can block another user's payments: there is no external call in `receive()`. Fees accrue internally and are pushed separately by `collectFees()`. Residual risks:
* An ERC-20 transfer to the bare implementation address would be stuck. The app never shows that address.
* Arc blocklist reverts still consume gas.

**I-8: Gas with 8 jars. Bounded.**
`MAX_JARS = 8` bounds every loop. Measured: first `receive()` with 8 jars ≈ 146k gas, `sweep()` ≈ 138k, `createJar` ≈ 632k (all slots cold). The wallet-estimated 3-jar payment on the real testnet node was 74k. `jars()` returns everything in one call.

**I-9: Event attribution.** In a sweep, `Split.from` is the sweeper, not the payer. Indexers should attribute payers from the USDC `Transfer` logs (EIP-7708 system emitter or the ERC-20 interface).

**I-10: Compiler and EVM.** solc 0.8.30 with `evm_version = osaka` matches Arc's Osaka baseline. The full flow was re-run on `arc-anvil --network arc` forked from Arc testnet using the reviewed bytecode.

**I-11: Fee recipient.** `feeRecipient` (`0xc7AC…8CEd`) is immutable per implementation. If its key is lost, accrued *protocol fees* are unrecoverable (never user funds). If it is ever blocklisted, `collectFees` reverts harmlessly and fees just accumulate.

**I-12: Keeper.** The keeper is permissionless and holds no special rights. Dusting jars with ≥ `MIN_SWEEP` (0.01 USDC) to make it spend gas costs the attacker more than the keeper. If the keeper is down, ERC-20 and Memo payments simply wait for anyone to call `sweep()`.

---

## App findings

**A-M1: XSS through error text (Medium). Fixed.**
`load()` passed `e.message` from the RPC straight into `innerHTML`. Because the RPC can be chosen by a link (`?rpc=`), a hostile endpoint could run script on the app's origin, for example to swap the address on a pay page. All toast content is now built from escaped strings (`friendly()` → `esc()`). The UI test opens a link with an HTML-injection payload and asserts nothing executes.

**A-M2: Silent factory/RPC overrides (Medium). Fixed.**
A link such as `?factory=0xEvil` could make a user create a "jar" from a hostile factory whose implementation lets the attacker withdraw. The app now:
* shows a persistent warning banner whenever the factory or RPC differs from the build-time config;
* only shows **"Verified ArcJar"** when the address's runtime code is exactly the EIP-1167 clone of the *official* factory's implementation, read through the default RPC;
* flags non-ArcJar contracts (red) and not-yet-created addresses (amber).

**A-L1: Reverted transactions shown as success (Low). Fixed.** Writes and payments now wait for the receipt and check `status`.

**A-L2: Memo payment without a transfer shown as paid (Low). Fixed.** After a Memo payment the app requires a USDC `Transfer` log to the jar in the receipt. A call to a code-less address "succeeds" in the EVM, and the UI test shows this case is now caught.

**A-L3: Input crashes (Low). Fixed.** Inline validation now covers names (≤ 31 UTF-8 bytes), shares (0–100, ≤ 2 decimals, total ≤ 100%), lock dates (future, ≤ 10 years), addresses and amounts (> 0, ≤ 6 decimals).

**A-L4: Over-withdraw (Low). Fixed.** An amount above the jar balance is rejected. `type(uint256).max` is sent only for an exact full withdrawal.

---

## Test evidence

* `forge test`: 48 unit tests, 3 fuzz tests (1,000 runs each) and 3 invariants (128 runs × 64 calls, 0 reverts). All pass.
* `scripts/e2e.sh` on an `arc-anvil` fork of Arc testnet (`deployments/e2e-arc-testnet-fork.log`) covers deploy, create, native pay (estimated at 108k gas), ERC-20 pay + sweep (`balanceOf == native / 1e12`), Memo pay + sweep, the fixed-21k revert, the lock, withdraw, the post-unlock withdraw, collectFees, `rescueToken(USDC)` (reverts) and two-step ownership with the registry update.
* `app/scripts/ui-e2e.mjs`: 23 headless-Chrome checks (create with validation, verified pay page, native pay success screen, withdraw, lock, over-withdraw, Memo-without-transfer, unverified and not-created warnings, factory-override banner, XSS).

## Before mainnet (not code issues)

1. Get an external audit, or cap usage (README says "use small amounts").
2. Run and fund the keeper (`keeper/`). Otherwise ERC-20 and Memo payments wait for a manual "Split now".
3. Confirm the `feeRecipient` key is safely held (immutable), and confirm the explorer verifier URL used by `VERIFY=1`.
