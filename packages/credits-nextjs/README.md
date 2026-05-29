# @nehorai/credits-nextjs

Next.js adapter for the [`@nehorai/credits`](https://www.npmjs.com/package/@nehorai/credits) system. Provides NextAuth.js integration and a `withCredits` higher-order function for wrapping server actions with automatic credit handling.

## Features

- **`createWithCredits` HOF** -- Wrap server actions with reserve-execute-commit credit flow
- **`NextAuthCreditsProvider`** -- Authenticate credit operations using NextAuth.js sessions
- **Deferred execution** -- Background usage logging via Next.js `after()` API
- **Preview mode support** -- Skip credit checks in preview/draft mode
- **Lifecycle hooks** -- `afterCommit` for post-commit side effects (e.g. low-balance notifications) and `onError` to route handler exceptions to your own logger
- **Configurable** -- Custom `usageProvider`, `reservationExpiryMs`, `errorMessages`, and dynamic `operationCosts` (pass a getter for fresh per-request costs)
- **Re-exports `@nehorai/credits`** -- All core types and utilities available from this package

## Installation

```bash
pnpm add @nehorai/credits-nextjs
```

Peer dependencies: `next` >= 14.0.0, `next-auth` >= 5.0.0-beta.0

## Quick Start

### 1. Set up the auth provider

```typescript
import { createNextAuthCreditsProvider } from "@nehorai/credits-nextjs";
import { getCurrentUser } from "@/lib/auth/session";

const authProvider = createNextAuthCreditsProvider({
  getCurrentUser,
  adminUsers: ["admin-user-id", "admin@example.com"],
});
```

### 2. Set up the deferred executor

```typescript
import { createNextJsDeferredExecutor } from "@nehorai/credits-nextjs";
import { after } from "next/server";

const deferred = createNextJsDeferredExecutor(after);
```

### 3. Create the withCredits wrapper

```typescript
import { createWithCredits } from "@nehorai/credits-nextjs";
import { createFirestoreCreditRepository } from "@nehorai/credits-firestore";
import { getFirestore } from "firebase-admin/firestore";

const repository = createFirestoreCreditRepository(getFirestore());

const withCredits = createWithCredits({
  repository,
  authProvider,
  deferred,
  operationCosts: {
    story_generation: 10,
    image_generation: 10,
    template_generation: 5,
  },
});
```

### 4. Wrap server actions

```typescript
"use server";

export const generateStory = withCredits(
  { operationType: "story_generation" },
  async (user, data, reservation) => {
    const story = await generateStoryContent(data);
    return { success: true, data: story };
  }
);
```

The wrapper automatically:
1. Authenticates the user via NextAuth
2. Reserves credits before execution
3. On success: commits the reservation (deducts credits)
4. On failure: releases the reservation (refunds credits)
5. Logs usage in the background

## API Reference

### `createWithCredits(config)`

Creates a configured `withCredits` HOF.

```typescript
const withCredits = createWithCredits({
  repository: ICreditRepository,      // Credit repository instance
  authProvider: ICreditsAuthProvider, // Auth provider instance
  deferred: DeferredExecutor,         // Background task executor

  // Cost per operation type. Pass a getter to read fresh costs each
  // request (e.g. when costs are loaded from remote config).
  operationCosts: Record<string, number> | (() => Record<string, number>),

  // --- Optional ---
  generateRequestId?: () => string,   // Custom request ID generator
  usageProvider?: string,             // Provider recorded on usage logs (default "gemini")
  reservationExpiryMs?: number,       // Reservation TTL in ms (default 5 min)
  errorMessages?: {                   // Override default user-facing messages
    unauthorized?: string;
    reserveFailed?: string;
    unexpected?: string;
  },
  afterCommit?: (ctx) => void | Promise<void>, // Post-commit side effect (errors swallowed)
  onError?: (ctx) => void,            // Handler-exception hook (replaces console.error)
});
```

#### Lifecycle hooks

`afterCommit` fires after a reservation is successfully committed — ideal for
low-balance notifications or balance-aware logging. A thrown hook is swallowed,
so a post-commit side effect can never turn a committed action into a failure.

```typescript
afterCommit: async ({ userId, operationType, cost, reservationId, requestId }) => {
  const credits = await repository.getUserCredits(userId);
  if (credits) await checkAndNotifyLowBalance(userId, credits.balance);
},
```

`onError` fires when the wrapped handler throws — after the reservation has been
released and usage logged — so you can route the failure to your own logger
instead of the default `console.error`.

```typescript
onError: ({ userId, operationType, error, requestId }) => {
  logger.error("[Credits] action threw", { error, operationType, userId, requestId });
},
```

### `withCredits(options, handler)`

Wraps a server action with credit handling.

```typescript
const action = withCredits<InputType, OutputType>(
  {
    operationType: "story_generation", // Matches key in operationCosts
    customCost: 15,                    // Optional: override cost lookup
    resourceId: "story-123",           // Optional: for usage logging
    resourceType: "story",             // Optional: for usage logging
  },
  async (user, data, reservation) => {
    // user: { id, email, name }
    // data: InputType (passed by caller)
    // reservation: PortableReservation (for reference)
    return { success: true, data: result };
  }
);
```

### `createCreditsWrapperFactory(config)`

Creates a factory for operation-specific wrappers with preset defaults:

```typescript
const createWrapper = createCreditsWrapperFactory(config);

const withStoryCredits = createWrapper({ operationType: "story_generation" });
const withImageCredits = createWrapper({ operationType: "image_generation" });

// Usage
export const generateStory = withStoryCredits(async (user, data, reservation) => {
  return { success: true, data: story };
});
```

### `NextAuthCreditsProvider`

Implements `ICreditsAuthProvider` for NextAuth.js:

```typescript
import { NextAuthCreditsProvider } from "@nehorai/credits-nextjs";

const provider = new NextAuthCreditsProvider({
  getCurrentUser: () => getServerSession().then(s => s?.user ?? null),
  adminUsers: new Set(["admin-id"]), // Accepts Set<string> or string[]
});

const user = await provider.getCurrentUser();
const isAdmin = await provider.verifyAdminAccess(userId);
```

### `createNextJsDeferredExecutor(afterFn)`

Creates a `DeferredExecutor` using Next.js `after()`:

```typescript
import { after } from "next/server";
import { createNextJsDeferredExecutor } from "@nehorai/credits-nextjs";

const deferred = createNextJsDeferredExecutor(after);
```

## Related Packages

| Package | Description |
|---------|-------------|
| [`@nehorai/credits`](https://www.npmjs.com/package/@nehorai/credits) | Core credit system (types, service, in-memory repository) |
| [`@nehorai/credits-firestore`](https://www.npmjs.com/package/@nehorai/credits-firestore) | Firestore implementation of `ICreditRepository` |

## Repository

[https://github.com/NehoraiHadad/nehorai-plugins](https://github.com/NehoraiHadad/nehorai-plugins)

## License

MIT
