# @plugins/credits-firestore

Firestore implementation of the credits system repository interface from `@plugins/credits`.

## Installation

```bash
pnpm add @plugins/credits-firestore
```

## Prerequisites

- `@plugins/credits` - Core credits system types and interfaces
- `firebase-admin` - Firebase Admin SDK for Firestore access

## Quick Start

```typescript
import { createFirestoreCreditRepository } from "@plugins/credits-firestore";
import { getFirestore } from "firebase-admin/firestore";

// Get your Firestore instance
const db = getFirestore();

// Create the repository
const repository = createFirestoreCreditRepository(db);

// Use with CreditsService from @plugins/credits
import { CreditsService } from "@plugins/credits";

const creditsService = new CreditsService(repository);

// Get user credits
const credits = await creditsService.getUserCredits("user-123");

// Reserve credits for an operation
const reservation = await creditsService.reserveCredits("user-123", 10, "image_generation");

// Commit on success
await creditsService.commitCredits("user-123", reservation.id);

// Or release on failure
await creditsService.releaseCredits("user-123", reservation.id);
```

## Configuration Options

```typescript
const repository = createFirestoreCreditRepository(db, {
  // Default free credits for new users (default: 25)
  defaultFreeCredits: 50,

  // Custom function to get monthly limits by tier
  getMonthlyLimit: async (tier: string) => {
    const limits: Record<string, number> = {
      free: 25,
      basic: 100,
      premium: 500,
      unlimited: Infinity,
    };
    return limits[tier] ?? 25;
  },
});
```

## Firestore Collections

The repository uses the following collection structure:

```
users/{userId}/
  credits/
    balance           # User's credit balance document
  reservations/
    {reservationId}   # In-flight credit reservations
  transactions/
    {transactionId}   # Credit transaction history
  usageLogs/
    {logId}           # Usage audit trail
  journal/
    {entryId}         # Credit journal entries
```

### Balance Document Schema

```typescript
{
  userId: string;
  balance: number;           // Monthly credits (resets each period)
  bonusCredits: number;      // Purchased/admin credits (never reset)
  reserved: number;          // Credits locked for in-flight operations
  tier: "free" | "basic" | "premium" | "unlimited";
  monthlyLimit: number;
  monthlyUsed: number;
  monthlyResetAt: Timestamp;
  subscriptionExpiresAt: Timestamp | null;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}
```

## Features

- **Two-phase commit**: Reserve → Commit/Release pattern prevents double-spending
- **Atomic operations**: All credit operations use Firestore transactions
- **Monthly reset**: Automatic monthly credit reset with configurable limits per tier
- **Subscription expiry**: Handles subscription downgrades with grace periods
- **Journal entries**: Audit trail for all credit changes
- **Usage logging**: Track operations for analytics and debugging

## Testing

For testing, use the in-memory implementation:

```typescript
import { createInMemoryCreditRepository } from "@plugins/credits-firestore";

const testRepo = createInMemoryCreditRepository({
  defaultFreeCredits: 100,
});

// Use in tests without Firestore
```

## Re-exports

This package re-exports commonly used types from `@plugins/credits` for convenience:

```typescript
import {
  // Types
  type ICreditRepository,
  type PortableUserCredits,
  type PortableReservation,

  // Utilities
  toClientUserCredits,
  toDate,
  toPortableTimestamp,
  calculateAvailableCredits,
} from "@plugins/credits-firestore";
```

## License

MIT
