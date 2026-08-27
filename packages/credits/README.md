# @nehorai/credits

Framework-agnostic credits and billing system with two-phase commit for safe credit operations.

## Features

- **Two-phase commit** -- Reserve credits before executing operations, then commit or release
- **Journal-based audit trail** -- Every credit change is logged with source, reference, and metadata
- **Subscription tier management** -- Free, basic, premium, and unlimited tiers with monthly resets
- **Notification hooks** -- Low balance and subscription expiry notifications
- **REST API SDK** -- Client and admin SDK for external integrations
- **In-memory repository** -- Included for testing and development
- **Type-safe** -- Full TypeScript with portable types (no framework dependencies)

## Installation

```bash
pnpm add @nehorai/credits
```

## Quick Start

```typescript
import {
  CreditsService,
  createInMemoryCreditRepository,
} from "@nehorai/credits";

const repository = createInMemoryCreditRepository();
const service = new CreditsService(repository);

// Initialize a user with free tier
await service.initializeUserCredits("user-123");

// Check if user has enough credits
const check = await service.checkCredits("user-123", 10);
if (!check.hasCredits) {
  console.log(`Need ${check.shortfall} more credits`);
}

// Reserve-Execute-Commit pattern
const reservation = await service.reserveCredits("user-123", 10, "story_generation");
try {
  await doExpensiveWork();
  await service.commitCredits("user-123", reservation.id); // Deducts credits
} catch (error) {
  await service.releaseCredits("user-123", reservation.id); // Refunds credits
  throw error;
}
```

## API Reference

### `CreditsService`

The main service class. Accepts any `ICreditRepository` implementation.

| Method | Description |
|--------|-------------|
| `getUserCredits(userId)` | Get user balance (auto-handles monthly reset and subscription expiry) |
| `initializeUserCredits(userId)` | Create a new user with free tier |
| `getOrCreateUserCredits(userId)` | Get or initialize user credits |
| `checkCredits(userId, amount)` | Check if user has sufficient credits |
| `reserveCredits(userId, amount, operationType)` | Reserve credits (phase 1) |
| `commitCredits(userId, reservationId)` | Commit reservation (phase 2 -- success) |
| `releaseCredits(userId, reservationId)` | Release reservation (phase 2 -- failure). A no-op for any terminal status; use `releaseCreditsDetailed` to see a concurrent commit. |
| `addCredits(userId, amount, description, paymentRef?)` | Add credits (purchases, bonuses). Returns an `AddCreditsOutcome`: `created`, `replayed` or `conflict` -- see [`paymentRef`](#crediting-an-account-and-paymentref). |
| `updateTier(userId, tier, expiresAt?)` | Change subscription tier |
| `getUsageHistory(userId, limit?, offset?)` | Paginated usage history |
| `logUsage(log)` | Log a usage event for auditing |

### The V2 reservation boundary

The legacy `reserveCredits`/`commitCredits`/`releaseCredits` methods above still
work unchanged. Alongside them are `*Detailed` variants that return a **typed
outcome** instead of throwing, and accept a caller **idempotency key**:

```typescript
const outcome = await service.reserveCreditsDetailed(userId, 40, "story_generation", {
  idempotencyKey: `job:${jobId}`,
});

switch (outcome.outcome) {
  case "created":              break;  // fresh hold
  case "replayed":             break;  // same key + same amount/operation: same reservation
  case "insufficient":         break;  // outcome.available / .required / .shortfall
  case "idempotency_conflict": break;  // key reused with a different payload
}
```

Same idea for `commitCreditsDetailed` and `releaseCreditsDetailed`: the caller
that wins the transition gets `committed` / `released`, and every other caller
gets `already_terminal` with the status that won, rather than an exception.
That distinction is what lets a retry tell "someone else already did this" apart
from "this failed".

### Crediting an account, and `paymentRef`

`paymentRef` identifies a **credit event** — one webhook, one invoice, one
charge — and it is global, not per user: the same reference is the same event
whoever presents it. `addCreditsV2` says which of the three things happened:

```typescript
const outcome = await repository.addCreditsV2({
  userId,
  amount: 25,
  description: "Purchase",
  paymentRef: event.id,
});

switch (outcome.outcome) {
  case "created":  break;  // credited; outcome.transaction / .journalEntryId
  case "replayed": break;  // same reference, same payload: nothing was written
  case "conflict": break;  // same reference, different event: outcome.mismatch
}
```

A replay is decided on the *payload*, not on the reference being present: user,
amount, transaction type, journal source and reference type all have to match.
`description` is deliberately excluded, since a retry may legitimately
regenerate the copy. A `conflict` writes nothing at all — no balance change, no
transaction row, no journal entry.

Empty and whitespace-only references are normalised to "no reference", and a
padded one is trimmed to the same reference. Unlike an idempotency key, a blank
`paymentRef` is not an error: a key is an explicit request for exactly-once,
while a reference is an optional annotation on a credit.

`addCredits` on the service and `addCreditsAtomic` on the repository keep their
old signatures. `addCreditsAtomic` returns quietly on a genuine replay — that is
the idempotent no-op the caller asked for — and **throws**
`IDEMPOTENCY_CONFLICT` on a conflict, because a `void` return has nowhere to
report one and staying silent is indistinguishable from having credited.

In SQL the arbiter is the partial unique index on `payment_ref`, so concurrent
deliveries are resolved by the database rather than by a read-then-write. The
in-memory adapter gives the same three outcomes.

### A reservation row is not a hold

The V2 boundary rests on one invariant: **a row is a reservation only if the
same atomic operation that wrote it also increased `reserved` by its amount.**
`reserveCredits`/`reserveCreditsV2` records that as `holdPlacedAt`, in the same
transaction as the hold, and nothing else writes it.

Two consequences you can see from the outside:

- `createReservation` — the low-level row writer, which does not touch
  `reserved` — **refuses an `idempotencyKey`** with `UNSUPPORTED_OPERATION`. A
  key there would name a hold this method never placed. Place idempotent holds
  with `reserveCredits`/`reserveCreditsV2`.
- A reservation without `holdPlacedAt` is never adopted as a replay and cannot
  be committed, released or expired; it raises `UNBACKED_RESERVATION` and
  changes nothing. Rows that predate the field are backfilled by the SQL
  migration, so existing holds keep working.

Without this, a keyed row that no hold backed came back as `replayed`, and the
commit that followed passed its `reserved >= amount` check by consuming coverage
belonging to a different, genuine reservation.

### What an amount has to be

Every public method that writes a credit amount validates it first, in the
service *and* in both shipped repositories, so a direct adapter caller gets the
same guarantees. That covers values the adapter derives as well as the ones the
caller passes: balance and counter increments are checked as *results*, because
a legal increment on a legal balance can still land outside the column. The
in-memory adapter projects the whole record — the fields you set outright, the
increments applied on top of them, and every value derived from the result —
validates all of it, and only then writes anything back. It has no transaction
to roll back a partial write, so a refused call has to leave the record exactly
as it found it. That includes the journal's `balanceAfter`, which is a *total*
rather than one of the balance columns and so stays representable only if it is
checked in its own right; the error names both the field and the transition.

An amount that credits or debits a balance must be finite, greater than zero,
exact to two decimal places, and within
`numeric(12, 2)`; anything else raises `INVALID_AMOUNT` before the write.
(`Infinity` is the sentinel for an unlimited tier and is never written to a
column, so tier limits are allowed to be it.)

That is narrower than "a positive number". `1.005` and `0.1 + 0.2` are rejected
rather than silently rounded by the column — round to cents before calling.
Ledger *records* (`createTransaction`, `createJournalEntry`) are checked only for
representability, since a correcting entry may be negative and a balance may be
below zero.

The transitions re-check the amount they read back from storage, too. A
reservation row written with a negative amount — by an older version, a repair
script, a hand-run `UPDATE` — used to satisfy `reserved >= amount` trivially and
*add* credits on commit. Commit, release and expire all refuse it now and change
nothing, so the row waits for an operator instead of moving on arithmetic
nobody can trust.

The check runs before the early exits, not just before the write. A corrupt row
that is already `committed`, or not yet due to expire, would otherwise come back
as a successful `already_terminal` or `not_due` — which tells the caller the
reservation is fine. It raises `INVALID_AMOUNT` instead, for every status.

An adapter must validate the amount in the representation *its storage* returns,
before any conversion. The SQL adapter reads a `numeric` column as a string and
checks it with exact integer arithmetic, because converting first would hide the
problem: a legacy unconstrained `numeric` can hold `9999999999.9900001`, which
`Number()` rounds to a perfectly valid `9999999999.99`. `assertValidStoredAmount`
is the float-typed form for stores that hold JS numbers natively;
`assertValidStoredAmountRaw` is the one to use otherwise.

Guarantees a V2 repository must provide, and which the shipped adapters do:

- concurrent commits of one reservation deduct **once** and journal **once**;
- commit vs release vs expire has exactly **one** winner;
- a caller idempotency key is unique per `(user, key)`, and a replay returns the
  original reservation instead of placing a second hold;
- the balance mutation and the journal entry commit **together** or not at all.

**Not every repository implements V2.** Check before relying on it:

```typescript
import { supportsCreditsV2 } from "@nehorai/credits";

if (supportsCreditsV2(repo)) { /* V2 methods are available */ }
```

`InMemoryCreditRepository` and `@nehorai/credits-drizzle` implement V2.
`@nehorai/credits-firestore` does **not** — it remains legacy-only, and gets no
idempotency-key or single-winner guarantees. `supportsCreditsV2` returns `false`
for it and the legacy code path is used, exactly as before.

Two things follow from that, and they are enforced rather than assumed:

- Passing an `idempotencyKey` to a non-V2 repository throws
  `UNSUPPORTED_OPERATION` before the reserve is attempted. It does not silently
  drop the key and report a fresh hold, because a retry would then charge twice.
- On a non-V2 repository, `commitCreditsDetailed` and `releaseCreditsDetailed`
  **cannot promise a single winner**. They read the status and then write, with
  no lock or compare-and-set between, so two concurrent commits can both
  proceed. `committed` there means "this call did the work", not "only this call
  did".

The Drizzle adapter needs a schema migration before V2 calls work; see its
README. It fails loudly rather than silently double-holding if the migration
has not been applied.

### `ICreditRepository`

Interface for database implementations. Implement this to use any database backend.

Key methods: `getUserCredits`, `initializeUserCredits`, `reserveCreditsAtomic`, `commitReservationAtomic`, `releaseReservationAtomic`, `addCreditsAtomic`, `atomicMonthlyReset`, `createJournalEntry`, `findAndExpireReservations`.

Optional V2 methods: `reserveCreditsV2`, `commitReservationV2`, `releaseReservationV2`, `expireReservationV2`. A repository that implements all four owns its own journal writes; the service layer will not add a second entry.

### `InMemoryCreditRepository`

In-memory implementation of `ICreditRepository` for testing:

```typescript
import { createInMemoryCreditRepository } from "@nehorai/credits";

const repo = createInMemoryCreditRepository();
```

### Error Handling

```typescript
import { CreditError, isCreditError, CreditErrorCode } from "@nehorai/credits";

try {
  await service.reserveCredits(userId, 100, "expensive_op");
} catch (error) {
  if (isCreditError(error) && error.code === CreditErrorCode.INSUFFICIENT_CREDITS) {
    // Handle insufficient credits
  }
}
```

`CreditErrorCode` is a stable contract, so callers can branch on the cause
rather than on message text:

| Code | Meaning |
|------|---------|
| `INSUFFICIENT_CREDITS` | The user cannot cover the amount. Not retryable as-is. |
| `IDEMPOTENCY_CONFLICT` | The key was reused with a different amount or operation. A bug in the caller, not a race. |
| `RESERVATION_NOT_FOUND` | No such reservation for that user. |
| `RESERVATION_ALREADY_PROCESSED` | Someone already committed, released, or expired it. |
| `RESERVATION_EXPIRED` | The hold lapsed before it was committed. |
| `INVALID_AMOUNT` | Amount was not a finite positive number on the cent grid and within `numeric(12, 2)`; or a stored reservation amount failed the same check; or the arithmetic overflowed the column (`details.reason`). |
| `UNBACKED_RESERVATION` | The reservation does not record that its hold was placed atomically, so the credits it claims may never have been held. The operation was refused before any state changed. |
| `CORRUPT_RESERVATION_STATUS` | The stored status is not one of `reserved`/`committed`/`released`/`expired`. The row is quarantined for an operator; nothing changed. |
| `INVALID_IDEMPOTENCY_KEY` | Key was empty, whitespace-only, or in the `reservation:` namespace the V2 transitions own. |
| `TRANSIENT_ERROR` | Deadlock, serialisation failure, lock timeout, connection loss. **Safe to retry** — with the same idempotency key. |
| `DATABASE_ERROR` | A database failure that is not known to be transient. |
| `CONFIGURATION_ERROR` | Misconfiguration (tiers, costs, adapter wiring). |
| `USER_NOT_FOUND` / `INVALID_OPERATION_TYPE` / `UNSUPPORTED_OPERATION` | Bad input, or a V2 call against a legacy repository. |

`isTransientError(error)` is the one to branch on for retry logic. One honest
caveat: a lost connection is reported as transient, but if it dropped during
COMMIT the operation may have succeeded. Retries are safe for the transitions
(the status CAS makes them idempotent) and for reserve **only when you pass an
`idempotencyKey`**.

### Amounts

Credit amounts are stored as `numeric(12, 2)`, so only values on the cent grid
up to `9999999999.99` are representable. Anything off that grid — non-finite,
out of range, or with more than two decimals — is rejected with `INVALID_AMOUNT`
before any write, rather than being silently rounded on the way into the
database.

Two rules, not one. An amount that *moves* — a deduction, a hold, a purchase —
must also be strictly positive. An amount that is merely *recorded* need not be:
a release journals `amount: 0`, and a corrected account has a negative
`balanceAfter`, so the transaction and journal writers check representability
alone. Derived totals are summed on the cent grid rather than with float
arithmetic, because `0.10 + 0.20` is `0.30000000000000004` and would otherwise
fail a check it should pass.

```typescript
import { isValidCreditAmount, toCents, sameAmount } from "@nehorai/credits";

isValidCreditAmount(1.05);   // true
isValidCreditAmount(1.005);  // false — a third decimal the column cannot hold
toCents(1.1);                // 110
sameAmount("40.00", 40);     // true — exact, not float comparison
```

### SDK Clients

REST API clients for external integrations:

```typescript
import { CreditsClient, AdminCreditsClient } from "@nehorai/credits";

// User-facing client
const client = new CreditsClient({ baseUrl: "/api/v1/credits", getToken });

// Admin client
const admin = new AdminCreditsClient({ baseUrl: "/api/v1/admin", getToken });
```

### Core Types

| Type | Description |
|------|-------------|
| `PortableUserCredits` | User balance with tier, monthly limits, timestamps |
| `PortableReservation` | Credit reservation for two-phase commit |
| `PortableTransaction` | Purchase/refund transaction record |
| `PortableJournalEntry` | Audit trail entry |
| `PortableUsageLog` | Operation usage log |
| `CreditCheckResult` | Result of credit sufficiency check |
| `SubscriptionTier` | `"free" \| "basic" \| "premium" \| "unlimited"` |
| `WithCreditsOptions` | Options for the `withCredits` HOF |

### Sub-path Exports

```typescript
import { ... } from "@nehorai/credits/core";       // Core types and errors
import { ... } from "@nehorai/credits/repository";  // Repository types and in-memory impl
import { ... } from "@nehorai/credits/auth";         // Auth provider types
import { ... } from "@nehorai/credits/service";      // CreditsService
import { ... } from "@nehorai/credits/adapters";     // Adapter types
import { ... } from "@nehorai/credits/sdk";          // REST API clients
```

## Related Packages

| Package | Description |
|---------|-------------|
| [`@nehorai/credits-firestore`](https://www.npmjs.com/package/@nehorai/credits-firestore) | Firestore implementation of `ICreditRepository` |
| [`@nehorai/credits-nextjs`](https://www.npmjs.com/package/@nehorai/credits-nextjs) | Next.js adapter with NextAuth integration |

## Repository

[https://github.com/NehoraiHadad/nehorai-plugins](https://github.com/NehoraiHadad/nehorai-plugins)

## License

MIT
