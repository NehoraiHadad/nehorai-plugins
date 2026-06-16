# nehorai-plugins

Monorepo for the `@nehorai/*` package family — framework-agnostic building blocks for **credits/billing** and **payment orchestration**.

Two independent but composable families live here:

- **Credits** — a credits system with two-phase commit for safe, atomic credit operations.
- **Payments** — a provider-agnostic payment orchestration layer with circuit breaking and multi-provider routing, plus provider, ORM, and framework adapters.

## Packages

### Credits

| Package | Version | Description |
|---------|---------|-------------|
| [`@nehorai/credits`](./packages/credits) | [![npm](https://img.shields.io/npm/v/@nehorai/credits)](https://www.npmjs.com/package/@nehorai/credits) | Core credit system: types, `CreditsService`, `ICreditRepository` interface, in-memory repository, SDK clients |
| [`@nehorai/credits-firestore`](./packages/credits-firestore) | [![npm](https://img.shields.io/npm/v/@nehorai/credits-firestore)](https://www.npmjs.com/package/@nehorai/credits-firestore) | Firestore implementation of `ICreditRepository` with atomic transactions (peer dep: `firebase-admin`) |
| [`@nehorai/credits-nextjs`](./packages/credits-nextjs) | [![npm](https://img.shields.io/npm/v/@nehorai/credits-nextjs)](https://www.npmjs.com/package/@nehorai/credits-nextjs) | Next.js adapter: NextAuth integration, `createWithCredits` HOF for server actions (peer deps: `next`, `next-auth`) |

### Payments

| Package | Version | Description |
|---------|---------|-------------|
| [`@nehorai/payments`](./packages/payments) | [![npm](https://img.shields.io/npm/v/@nehorai/payments)](https://www.npmjs.com/package/@nehorai/payments) | Generic payment orchestration library with circuit breaker and multi-provider routing |
| [`@nehorai/payments-stripe`](./packages/payments-stripe) | [![npm](https://img.shields.io/npm/v/@nehorai/payments-stripe)](https://www.npmjs.com/package/@nehorai/payments-stripe) | Stripe provider for `@nehorai/payments` (peer dep: `stripe`) |
| [`@nehorai/payments-sumit`](./packages/payments-sumit) | [![npm](https://img.shields.io/npm/v/@nehorai/payments-sumit)](https://www.npmjs.com/package/@nehorai/payments-sumit) | SUMIT (UPAY) hosted-checkout provider adapter for `@nehorai/payments` |
| [`@nehorai/payments-il`](./packages/payments-il) | [![npm](https://img.shields.io/npm/v/@nehorai/payments-il)](https://www.npmjs.com/package/@nehorai/payments-il) | Israeli payment providers (Hyp, Cardcom) for `@nehorai/payments` |
| [`@nehorai/payments-drizzle`](./packages/payments-drizzle) | [![npm](https://img.shields.io/npm/v/@nehorai/payments-drizzle)](https://www.npmjs.com/package/@nehorai/payments-drizzle) | Drizzle ORM persistence adapter for `@nehorai/payments` (peer dep: `drizzle-orm`) |
| [`@nehorai/payments-nextjs`](./packages/payments-nextjs) | [![npm](https://img.shields.io/npm/v/@nehorai/payments-nextjs)](https://www.npmjs.com/package/@nehorai/payments-nextjs) | Next.js App Router integration for `@nehorai/payments` (peer dep: `next`) |

## Architecture

Each family follows the same layering: a framework-free **core** defines the interfaces, **adapters** plug in databases, providers, and frameworks.

```
@nehorai/credits                 Core types, service, in-memory repo (no framework deps)
    ├── @nehorai/credits-firestore   Firestore ICreditRepository implementation
    └── @nehorai/credits-nextjs      Next.js / NextAuth adapter

@nehorai/payments                Core orchestrator: routing, circuit breaker, provider/repository interfaces
    ├── @nehorai/payments-stripe     Stripe provider
    ├── @nehorai/payments-sumit      SUMIT (UPAY) provider
    ├── @nehorai/payments-il         Israeli providers (Hyp, Cardcom)
    ├── @nehorai/payments-drizzle    Drizzle ORM persistence adapter
    └── @nehorai/payments-nextjs     Next.js App Router integration
```

The core packages define the interfaces (`ICreditRepository`, the payment provider/repository contracts). Database and provider adapters implement those interfaces; framework adapters wire them into authentication and request handling. The two families are independent — use either on its own, or combine them to grant credits on successful payment.

## Quick Start

### Credits

```bash
# Core only (with in-memory repo for testing)
pnpm add @nehorai/credits

# With Firestore backend
pnpm add @nehorai/credits-firestore firebase-admin

# With Next.js integration
pnpm add @nehorai/credits-nextjs
```

```typescript
import { createFirestoreCreditRepository, CreditsService } from "@nehorai/credits-firestore";
import { createWithCredits, createNextAuthCreditsProvider } from "@nehorai/credits-nextjs";

// Set up repository and service
const repository = createFirestoreCreditRepository(getFirestore());
const service = new CreditsService(repository);

// Wrap server actions with credit handling
const withCredits = createWithCredits({
  repository,
  authProvider: createNextAuthCreditsProvider({ getCurrentUser }),
  deferred: createNextJsDeferredExecutor(after),
  operationCosts: { example_operation: 10 },
});
```

### Payments

```bash
# Core orchestrator
pnpm add @nehorai/payments

# Add the providers you need
pnpm add @nehorai/payments-stripe stripe
pnpm add @nehorai/payments-sumit
pnpm add @nehorai/payments-il

# Optional persistence + framework adapters
pnpm add @nehorai/payments-drizzle drizzle-orm
pnpm add @nehorai/payments-nextjs
```

See each package's README for provider-specific setup (API keys, webhooks, and verify-on-return flows).

## Development

```bash
pnpm install     # Install dependencies
pnpm build       # Build all packages
pnpm test        # Run all tests
pnpm typecheck   # Type-check all packages
```

## License

MIT
