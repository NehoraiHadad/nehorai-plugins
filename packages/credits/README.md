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

### `ICreditRepository`

Interface for database implementations. Implement this to use any database backend.

Key methods: `getUserCredits`, `initializeUserCredits`, `reserveCreditsAtomic`, `commitReservationAtomic`, `releaseReservationAtomic`, `addCreditsAtomic`, `atomicMonthlyReset`, `createJournalEntry`, `findAndExpireReservations`.

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
