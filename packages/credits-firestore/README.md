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
