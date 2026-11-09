# @nehorai/credits-firestore

## 3.3.0

Requires `@nehorai/credits` 3.3.0.

### Added

- **Credit lots**, with `new FirestoreCreditRepository(db, { lotLedger: "on", onLotDrift })`.
  Off by default: with lots off nothing below is written. See the core changelog for the
  model and the draw order.
- **Storage.** The open lots are inline on the balance document (`lots`), read and
  written in the same transaction as the balance by every writer. Each lot has a header
  at `users/{uid}/credits/data/lots/{lotId}`, created when it opens and given its closing
  totals (`closedAt`, `drawnValueMicros`, `drawnFeeMicros`) when it empties; a lot that
  opens and empties in one write is created closed. Each event is created once at
  `users/{uid}/credits/data/lot_events/{sha256 of its key}`. Headers and events carry
  `userId` for collection-group queries.
- **`getLotLedger`, `getLotHeader`, `reverseLot`** (`ICreditRepositoryLots`). `reverseLot`
  reads its event, the balance and the header in one transaction; the event document is
  the idempotency guard.
- **`SubscriptionCycleGrantInput.lot`** (`LotSpec`): what the allotment was paid. The
  grant replaces the balance lots with one lot (`sourceType` `subscription_cycle`, or
  pass `subscription_upgrade`; `sourceRef` the `grantKey`). Only the new plan's credits
  stay; the old allotment expires as `cycle_replaced`, except what backs open holds,
  which a commit draws first. Validated even when lots are off.
- **`options.lot` on `addCreditsAtomic` and `addCreditsIdempotent`**, validated even
  when lots are off. A seeded missing account opens a free `seed` lot.
- Commits store `lotDraws` and `lotTotals` on the reservation document and on the
  journal line's metadata.
- Drift is reported after the transaction commits, from the attempt that committed.
- Exports `LotOps`, `getUserLotsPath` and `getUserLotEventsPath`.
- `findAndExpireReservations(db, batchSize, maxIterations, lotOptions?)` and the module
  functions of every writer take a trailing `LotLedgerOptions`.

## 3.2.0

Requires `@nehorai/credits` 3.2.0.

### Fixed

- **A signup gift is no longer lost at the first subscription.** The gift passed as
  `initialBalance` landed in `balance`, and `grantSubscriptionCycle` (which sets the
  balance), the expiry cap (to `getDowngradeBalanceCap`, often 0) and a paid
  `updateUserTier` with a `balance` all replaced or capped it.

### Added

- **`signupBonus` on `initializeUserCredits`.** `balance` and `monthlyLimit` are
  `initialBalance`, and the gift is `bonusCredits`. With `signupGrantClaim`, the bonus is 0
  when the claim exists, and a bonus above 0 creates the claim. `signupGrant` records the
  bonus given. The claim, the account and the journal line commit in one transaction, as
  before. It is one line, `referenceId` `signup-<userId>`: `amount` and `balanceAfter` the
  allotment plus the bonus, `balanceBefore` 0, `metadata.buckets` `{ balance, bonus }`.

### Deprecated

- **Passing a signup gift as `initialBalance`.** Without `signupBonus` the call is
  unchanged from 3.1.0: a taken claim starts the account at 0, and the claim guards the
  balance.

```typescript
// Before: the gift is `balance`, and the first subscription replaces it.
await repo.initializeUserCredits(userId, "free", 65, { signupGrantClaim });
// After: the allotment is `balance`, the gift is `bonusCredits`.
await repo.initializeUserCredits(userId, "free", 0, { signupBonus: 65, signupGrantClaim });
```

Accounts created before the upgrade keep their gift in `balance`. This release moves no
data.

## 3.1.0

Requires `@nehorai/credits` 3.1.0.

### Upgrading

**If you write a signup-grant or tier-change journal line yourself, stop, or it is written
twice.** `initializeUserCredits`, `updateUserTier` and the account seeds below now write
these lines in their own transaction.

### Changed

- **A new account's starting balance is journaled in the transaction that creates it**, so a
  retry or a concurrent creation leaves one line. This covers `initializeUserCredits` and an
  account seeded by `addCreditsAtomic`, `reserveCreditsAtomic` or `reserveCreditsV2`. A
  balance of 0, including a taken signup claim, writes none. The line is `credit`,
  `source: "bonus"`, `referenceType: "adjustment"`, `balanceBefore` 0.
- **`updateUserTier` journals in its transaction when it moves the balance**, with one line.
  A raise is `credit`, `source: "subscription_upgrade"`, `amount` the balance it set. A cut
  is `debit`, `source: "subscription_downgrade"`, `amount` 0. `balanceBefore` and
  `balanceAfter` are `balance + bonusCredits`.
- **A tier write the journal cannot record is refused.** If `balanceBefore` or `balanceAfter`
  would exceed `CREDIT_AMOUNT_MAX`, because of `balance + bonusCredits`, a write that moves
  the balance now fails the transaction with `INVALID_AMOUNT`. It used to succeed.

## 3.0.0

No data migration is needed: documents from 2.2.0 keep working as stored. Deploy every
instance together: a 2.2.0 instance ignores the frontier and reads no share from a hold
written since.

### Breaking

- `atomicMonthlyReset`, `checkAndHandleSubscriptionExpiry` and `addCreditsAtomic` journal
  in their transaction. **A caller that wrote its own line for one must stop, or the line
  is written twice.**
- `addCreditsAtomic`, `deductCreditsAtomic`, `updateUserCredits`, `updateUserTier`,
  `initializeUserCredits`, `createTransaction` and `createJournalEntry` refuse an off-grid
  value with `INVALID_AMOUNT`.
- `updateUserTier` always runs a transaction. On a missing account it throws
  `User credits not found` where the plain update threw Firestore's `NOT_FOUND`.

### Changed

- **`expiredBacking` on a 2.2.0 hold document is the record of its share.** Allocating by
  timestamp alone gave the share to an older hold from a lagging server: with a balance of
  80, a bonus of 100 and hold A carrying all 80 marks, commit(B) then release(A) left 100
  instead of 20, and release(B) then commit(A) left 20 instead of 100. The stored share now
  decides, in both orders. A lowering write that goes below the records rewrites those
  documents, at most one write for each hold still open from before the upgrade.
- **Every write leaves `0 <= expiredHoldBacking <= balance`.** A credit and a tier write
  stored nothing to repair a bad value. A sound total that does not change reads no hold.
- **What a walk of the open holds costs, and how it fails.** One read per open hold of the
  account, once when a marked account without a frontier is first closed or reserved on,
  and on a write that changes a positive total. Firestore sets no limit on the documents
  a transaction reads. Its limits are a 270 second lifetime and 60 second idle expiry, so a
  walk that cannot finish fails its transaction: the client retries, then the error reaches
  the caller, nothing is written, and no balance is computed from part of the holds.

- **A lowering write no longer writes every hold.** With 100,000 holds of 0.01 that
  single transaction was over the 10 MiB request limit, so every reset, downgrade, cap,
  grant and absolute balance failed on the account. Shares are now derived from
  `expiredBackingFrontier` on the balance document. A close writes its own documents only,
  whatever else is open. A lowering write that changes the total reads `amount`,
  `holdPlacedAt` and `expiredBacking` of the open holds.
- **Existing documents convert on first touch.** A total with no frontier is placed on the
  open holds the next time a hold is placed or closed or the total is written.
- **A bad stored value no longer mints or locks.** `expiredHoldBacking` is read within
  the balance and repaired by the next write. Float noise from `FieldValue.increment`
  reads as the cent it landed next to, an off-grid `balance`, `bonusCredits` or
  `monthlyUsed` rounds down, and `reserved` rounds up.
- **The journal is written in the transaction it records.** `atomicMonthlyReset` and
  `checkAndHandleSubscriptionExpiry` now journal in their transaction and return
  `journaled: true`, `addCreditsAtomic` writes its line and honours
  `AddCreditsAtomicOptions`, which the repository dropped, and `deductCreditsAtomic`
  takes `DeductJournalInput`. **A caller that wrote its own line for a reset, a
  downgrade or an `addCreditsAtomic` must stop, or the line is written twice.**
- **Amounts are whole cents on every path.** `addCreditsAtomic`, `deductCreditsAtomic`,
  `updateUserCredits`, `updateUserTier`, `initializeUserCredits`, `createTransaction` and
  `createJournalEntry` refuse an off-grid value with `INVALID_AMOUNT`, as the other
  adapters do. A deduct of a non-positive amount now throws `CreditError` too. The two
  record writers first take float noise back to the cent, so a caller's raw difference
  does not fail the audit line after the balance moved.
- A credit that seeds a missing account records the seeded balance in
  `previousBalance` and `newBalance`, which stated 0 before.

## 2.2.0

- **`atomicMonthlyReset` uses the tier read inside the transaction.** It computed
  the limit from the `tier` argument, read before the transaction, so a downgrade
  landing in between gave a free account the paid limit (25 became 500 and stayed
  free). The signature is unchanged and the argument is no longer trusted.
- **`resolveMonthlyReset` option.** Decides a due reset inside the transaction
  from the current tier and balance. `null` means no reset and no write
  (`wasReset: false`, `monthlyResetAt` unchanged). It takes precedence over
  `getMonthlyLimit`, `monthlyLimit` is written only when returned, and a throw
  aborts the transaction. The result is validated, and the balance is floored at
  the credits backing outstanding holds. `monthlyUsed` is zeroed,
  `monthlyResetAt` advanced and `bonusCredits` untouched, as on any reset. The
  resolver must be synchronous and free of side effects, because a contended
  transaction runs it again.
- **`getDowngradeBalanceCap` option.** The balance cap and `monthlyLimit` of a
  subscription-expiry downgrade, instead of the hard-coded `DEFAULT_FREE_CREDITS`.
  With the option, the balance also stops at the credits backing outstanding
  holds.
- **`updateUserTier` honours `balanceCap`** in a transaction that reads the stored
  balance and tier, so a concurrent charge can no longer be written back (read 20,
  charge to 0, the downgrade wrote 20). It is ignored for an account already free.
  Without it, this is the same plain update. Passing both `balance` and
  `balanceCap` is refused.
- **`initializeUserCredits` creates only if missing.** It was an unconditional
  `set`, so a late second call wiped a balance, bonus and reserved already in use.
  It is now a transaction that returns an existing account unchanged, for every
  caller.
- **Signup grant claim.** `initializeUserCredits(userId, tier, initialBalance,
  { signupGrantClaim })` takes a `DocumentReference`. A new account starts at 0 when
  the claim exists. Otherwise it gets the grant, and a grant above 0 writes the claim
  with only a server timestamp. `signupGrant` on the balance document, and on
  `PortableUserCredits`, records the amount granted and is absent when none was.
- **`getNextMonthStart` on the 31st.** `setMonth` overflowed, so 31 January gave
  1 March. It now uses the core `getNextMonthlyReset`, the one implementation.
- **`addCreditsIdempotent`** credits once per `paymentRef`: guard row, balance and
  journal entry in one transaction, returning `AddCreditsOutcome`. `alsoUpdate`
  updates a caller's document in that transaction. `addCreditsAtomic` is unchanged.
- **`grantSubscriptionCycle`** applies a renewal or upgrade once per `grantKey`:
  balance, tier, expiry, `monthlyResetAt`, limit and the journal entry from the
  snapshot it read, in one transaction. A repeat cannot restore spent credits.
- **Expired credits backing a hold.** A balance-lowering write kept that part of the
  balance, and a release then left it spendable forever. `expiredHoldBacking` now
  records the total and each open hold records its share as `expiredBacking`, oldest
  hold first. A hold placed later has none. Closing a hold settles only its own share:
  a commit consumes it and a release or expiry removes it, on every path, so final
  balances do not depend on close order. A deduct draws on spendable balance and bonus,
  never on these credits. `grantSubscriptionCycle` and an absolute balance replace
  them, a repeated cap keeps them, and a bonus purchase does not revive them.
  `resolveMonthlyReset` now receives the balance without them. Documents lacking the
  fields read as 0 and are not rewritten with them. The total is always the sum of the
  open holds' shares, written together, and a closing hold touches only its own share.
- **A negative `balanceIncrement` draws only on valid credits.** It is refused if it
  would take the balance below `expiredHoldBacking`, and never lowers the total or a
  share. An absolute `balance` still replaces the field and clears both.
- **`updateUserCredits` validates what it writes.** Naming an absolute field and its
  increment checked the absolute but stored the increment on the old value, so
  `{ balance: 1000, balanceIncrement: -1090 }` stored a negative balance. The increment
  now applies on top of the absolute, as on the other adapters.
- **Hold floor everywhere.** The legacy reset, the default downgrade and
  `updateUserTier({ balance })` could cut through credits backing a hold, stranding
  the commit. All three now stop at the floor and mark what it kept.
  `updateUserTier({ balance })` is therefore a transaction, and on a missing account
  it throws `User credits not found`.
- **`seedMissingAccounts` option,** default true. `addCreditsAtomic`,
  `reserveCreditsAtomic` and `reserveCreditsV2` create a missing account with
  `DEFAULT_FREE_CREDITS`, with no claim and ignoring any configured grant, and
  `addCreditsIdempotent` creates one at 0. With `false`, all four throw
  `USER_NOT_FOUND` inside the transaction and write nothing, so only
  `initializeUserCredits` creates accounts.
- `createFirestoreCreditRepository` returns `FirestoreCreditRepository`, so these
  methods are reachable. It is still an `ICreditRepository`.
- Requires `@nehorai/credits` 2.2.0.

## 2.1.0

The adapter now implements the V2 reservation boundary (`reserveCreditsV2`,
`commitReservationV2`, `releaseReservationV2`, `expireReservationV2`), so
`supportsCreditsV2` is true and `CreditsService` settles holds through it.

- **One journal row per transition, written in the same transaction.** On 2.0.0
  this adapter took core's legacy path: the reservation status was read outside
  any transaction and the journal entry was written after the commit's
  transaction. Two concurrent commits both wrote a debit row (the balance was
  charged once), and a crash between the commit and the journal write lost the
  row. Each transition is now one Firestore transaction that reads the
  reservation, the balance and the journal document, and writes all three only
  if the status is still `reserved`. The journal document id is
  `reservationJournalKey(reservationId, transition)`, so a duplicate cannot be
  created even by a write outside this module.
- **Balances are written on the cent grid.** Every balance writer — the
  transitions, `addCreditsAtomic`, `deductCreditsAtomic` and the increments of
  `updateUserCredits` — writes exact values computed with `sumAmounts` inside a
  transaction, instead of `FieldValue.increment`, which adds in IEEE 754
  (`0.1 + 0.2` stored `0.30000000000000004`, a value V2 then refuses).
  `updateUserCredits` now validates and writes in one transaction.
- **Reserve records `holdPlacedAt`** in the same transaction that raises
  `reserved`, and honours `idempotencyKey` through a key index at
  `users/{userId}/reservation-keys/{sha256(key)}`.
- **The legacy `*Atomic` methods delegate to V2**, as in the memory and Drizzle
  adapters, so both surfaces share one implementation. `expireReservationAtomic`
  keeps its 1.x semantics: it expires a `reserved` hold without checking
  `expiresAt`. Expiry and release are now journalled on every path.
- **The cleanup sweep pages with a cursor.** A candidate the transition refuses
  stays `reserved`; re-running the same query selected it again on every
  iteration and starved every due reservation behind it.
- **`getReservation` returns `holdPlacedAt` and `idempotencyKey`.**
  `createReservation` refuses an idempotency key and `updateReservationStatus`
  refuses rows backed by a placed hold and any reopening to `reserved` (core
  2.0's record-only guards).

### Migration

V2 refuses a reservation without `holdPlacedAt` (`UNBACKED_RESERVATION`),
including retries on already-settled rows. Every reservation written by an
earlier version of this adapter lacks the field. If your application only ever
created holds with `reserveCreditsAtomic` / `reserveCredits` (never
`createReservation`), those rows are genuinely backed: backfill
`holdPlacedAt = createdAt` on every reservation document that lacks it, before
deploying and again once the rollout has finished.

V2 also refuses a balance field off the cent grid. Earlier versions moved
balances with `FieldValue.increment`, which adds in IEEE 754, so fractional
amounts may have left drift such as `0.30000000000000004`. In the same pass,
rewrite any balance field within float noise of a cent to that exact cent value;
report anything further off for an operator.

## 2.0.0

Compatibility release for `@nehorai/credits` 2.x — the dependency range moves
from `^1.5.0` to `^2.0.0`. No Firestore adapter API changes.

The major version matches core's: core 2.0.0 made `createReservation` /
`updateReservationStatus` loudly record-only (they are not a hold path), and
apps consuming this adapter get that core transitively. Audit callers that
used those two methods as a two-phase commit; holds go through the atomic
reserve family.

This adapter keeps the legacy journaling path: it does not report
`journaled: true`, so `CreditsService` continues to write reset/downgrade
journal entries itself, exactly as on 1.x.
