# @nehorai/credits-firestore

Firestore implementation of the [`@nehorai/credits`](https://www.npmjs.com/package/@nehorai/credits) repository interface. Provides atomic credit operations using Firestore transactions.

## Features

- **Atomic operations** -- All credit mutations use Firestore transactions to prevent race conditions
- **Two-phase commit** -- Reserve, commit, and release credits atomically
- **Monthly reset** -- Optimistic-locking-based monthly credit reset
- **Subscription management** -- Tier upgrades/downgrades with grace periods
- **Reservation cleanup** -- Batch expiration of stale reservations
- **Journal and audit trail** -- Full audit log of every credit change
- **Re-exports `@nehorai/credits`** -- All core types and utilities available from this package

## Installation

```bash
pnpm add @nehorai/credits-firestore firebase-admin
```

`firebase-admin` >= 12.0.0 is a peer dependency.

## Quick Start

```typescript
import {
  createFirestoreCreditRepository,
  CreditsService,
} from "@nehorai/credits-firestore";
import { getFirestore } from "firebase-admin/firestore";

// Create the repository with your Firestore instance
const db = getFirestore();
const repository = createFirestoreCreditRepository(db);

// Use with CreditsService from @nehorai/credits
const service = new CreditsService(repository);

// All operations are now backed by Firestore
const credits = await service.getOrCreateUserCredits("user-123");
const reservation = await service.reserveCredits("user-123", 10, "story_generation");
```

## Firestore Collections

The repository uses subcollections under each user document:

| Path | Description |
|------|-------------|
| `users/{userId}/credits/balance` | User's credit balance document |
| `users/{userId}/transactions` | Credit transaction history |
| `users/{userId}/reservations` | In-flight credit reservations |
| `users/{userId}/credits/data/journal` | Audit trail journal entries |
| `usage_logs` | Global usage log collection |

## API Reference

### `FirestoreCreditRepository`

Implements `ICreditRepository` from `@nehorai/credits`. All methods use Firestore transactions for atomicity.

```typescript
import { FirestoreCreditRepository } from "@nehorai/credits-firestore";

const repository = new FirestoreCreditRepository(db, {
  getMonthlyLimit: (tier) => tierLimits[tier], // Optional custom tier limits
});
```

### `createFirestoreCreditRepository(db, options?)`

Factory function that returns an `ICreditRepository` instance:

```typescript
import { createFirestoreCreditRepository } from "@nehorai/credits-firestore";

const repository = createFirestoreCreditRepository(db);
```

#### Options

| Option | Type | Description |
|--------|------|-------------|
| `getMonthlyLimit` | `(tier: SubscriptionTier) => number` | Custom monthly limit resolver for tier-based resets |
| `resolveMonthlyReset` | `(credits: { tier: SubscriptionTier; balance: number }) => { balance: number; monthlyLimit?: number } \| null` | Decides a due reset inside the transaction, from the current tier and balance. `null`: no reset and no write. Takes precedence over `getMonthlyLimit`. `monthlyLimit` is written only when returned, and a throw aborts. Must be synchronous and free of side effects, because a contended transaction runs it again. The balance is floored at the credits backing outstanding holds. |
| `getDowngradeBalanceCap` | `() => number` | Balance cap and `monthlyLimit` on a subscription-expiry downgrade. Default: `DEFAULT_FREE_CREDITS`. |
| `seedMissingAccounts` | `boolean` | Default `true`: `addCreditsAtomic`, `reserveCreditsAtomic` and `reserveCreditsV2` create a missing account with `DEFAULT_FREE_CREDITS`, and `addCreditsIdempotent` creates one at 0. `false`: all four throw `USER_NOT_FOUND` and write nothing, so call `initializeUserCredits` first. |

### Once-only credits and the signup claim

These are Firestore-specific, on `FirestoreCreditRepository`. Each runs in one
transaction, and `alsoUpdate` (`{ ref: DocumentReference, data }`) updates a document
of yours in it, only when the credit applies. A missing document fails the transaction.

```typescript
const repo = createFirestoreCreditRepository(db);

// Creates only if missing. `balance` and `monthlyLimit` are the tier allotment (0 here);
// the gift is `bonusCredits`, which grants, caps and tier writes keep. A taken claim
// gives a bonus of 0.
await repo.initializeUserCredits(userId, "free", 0, {
  signupBonus: 65,
  signupGrantClaim: claimRef,
});

// `created`, `replayed` or `conflict`. The guard is per user.
await repo.addCreditsIdempotent({
  userId,
  amount,
  description,
  paymentRef,
  alsoUpdate: { ref: orderRef, data: { creditsGranted: true } },
});

// `granted`, `replayed` or `conflict`. Sets the balance; bonus and holds are untouched.
await repo.grantSubscriptionCycle({
  userId,
  grantKey: chargeId,
  tier,
  credits,
  subscriptionExpiresAt: periodEnd,
  monthlyResetAt,
  description,
});
```

**Pass a signup gift as `signupBonus`, not as `initialBalance`.** Passing it as
`initialBalance` (the 3.1.0 call, still supported and unchanged) puts the gift in
`balance`, and `grantSubscriptionCycle`, the expiry cap and a paid `updateUserTier` all
replace or cap `balance`, so the first subscription loses whatever was unspent. That
usage is deprecated for a gift. Without `signupBonus` the claim guards `initialBalance`
as before.

`signupGrant` on the account is the amount granted (the bonus, or the legacy balance),
and is absent when no grant was given: a taken claim, a zero grant, or an account
created without a claim. The claim, the account and its journal lines commit in one
transaction. Whichever call creates an account, a starting balance above 0 is journaled
in that transaction with `source: "bonus"`. With `signupBonus`, the allotment and the
bonus get a line each (`metadata.bucket` `"balance"` and `"bonus"`, both with
`referenceId` `signup-<userId>`), and a bucket at 0 gets none. `updateUserTier` journals in its transaction when it
moves the balance: `subscription_upgrade` for a raise, `subscription_downgrade` for a cut.
`expiredHoldBacking` is the part of `balance` kept only to back holds. A hold from 2.2.0
keeps the share stored on its document, as `expiredBacking`. Other shares are allocated
oldest hold first, so `expiredBackingFrontier` on the balance document describes them
all: an older hold carries its full amount, the frontier hold its `share`, and a newer
one none, including a hold placed after the expiry. Closing a hold
settles its own share only: a commit consumes it, and a release or expiry removes it
from the balance. So final balances do not depend on the order holds close in, and a
deduct never lands on these credits. A write that changes the total reads the open holds
in its transaction, only when such credits exist, and writes a hold only to change a
stored 2.2.0 share. If that read cannot finish within Firestore's transaction limits (270
seconds, 60 idle), the operation fails and nothing is written.

### Module Functions

For advanced use cases, individual operation modules are exported:

```typescript
import {
  BalanceOps,
  TransactionOps,
  ReservationAtomicOps,
  ReservationCrudOps,
  UsageLogOps,
  CleanupOps,
  SubscriptionOps,
  JournalOps,
} from "@nehorai/credits-firestore";

// Use module functions directly with a Firestore instance
const credits = await BalanceOps.getUserCredits(db, userId);
```

### Utility Exports

```typescript
import {
  // Collection helpers
  COLLECTIONS,
  BALANCE_DOC_ID,
  getUserCreditsCollection,
  getUserTransactionsCollection,
  getUserReservationsCollection,
  getUsageLogsCollection,
  // Conversion utilities
  toISOString,
  toDate,
  timestampToISO,
  timestampToDate,
  calculateCreditDeduction,
  // State machine
  isValidTransition,
  validateTransition,
  getValidNextStates,
  isTerminalState,
  // Validation
  validateBalanceUpdate,
  assertValidBalanceUpdate,
  // Path helpers
  getUserCreditsPath,
  getUserTransactionsPath,
  getUserReservationsPath,
  getUserJournalPath,
} from "@nehorai/credits-firestore";
```

## Related Packages

| Package | Description |
|---------|-------------|
| [`@nehorai/credits`](https://www.npmjs.com/package/@nehorai/credits) | Core credit system (types, service, in-memory repository) |
| [`@nehorai/credits-nextjs`](https://www.npmjs.com/package/@nehorai/credits-nextjs) | Next.js adapter with NextAuth integration |

## Repository

[https://github.com/NehoraiHadad/nehorai-plugins](https://github.com/NehoraiHadad/nehorai-plugins)

## License

MIT
