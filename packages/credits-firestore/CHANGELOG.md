# @nehorai/credits-firestore

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
