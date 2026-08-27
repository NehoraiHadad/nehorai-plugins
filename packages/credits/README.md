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
| `releaseCredits(userId, reservationId)` | Release reservation (phase 2 -- failure) |
| `addCredits(userId, amount, description)` | Add credits (purchases, bonuses) |
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
| `INVALID_AMOUNT` | Amount was not a finite positive number. |
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
up to `9999999999.99` are representable. Anything else — non-finite,
zero or negative, or with more than two decimals — is rejected with
`INVALID_AMOUNT` before any write, rather than being silently rounded on the way
into the database.

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
