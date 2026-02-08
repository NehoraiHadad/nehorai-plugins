# @nehorai/credits

Monorepo for the `@nehorai/credits` package family -- a framework-agnostic credits and billing system with two-phase commit for safe credit operations.

## Packages

| Package | Version | Description |
|---------|---------|-------------|
| [`@nehorai/credits`](./packages/credits) | [![npm](https://img.shields.io/npm/v/@nehorai/credits)](https://www.npmjs.com/package/@nehorai/credits) | Core credit system: types, `CreditsService`, `ICreditRepository` interface, in-memory repository, SDK clients |
| [`@nehorai/credits-firestore`](./packages/credits-firestore) | [![npm](https://img.shields.io/npm/v/@nehorai/credits-firestore)](https://www.npmjs.com/package/@nehorai/credits-firestore) | Firestore implementation of `ICreditRepository` with atomic transactions |
| [`@nehorai/credits-nextjs`](./packages/credits-nextjs) | [![npm](https://img.shields.io/npm/v/@nehorai/credits-nextjs)](https://www.npmjs.com/package/@nehorai/credits-nextjs) | Next.js adapter: NextAuth integration, `createWithCredits` HOF for server actions |

## Architecture

```
@nehorai/credits          Core types, service, in-memory repo (no framework deps)
    |
    +-- @nehorai/credits-firestore   Firestore implementation (peer dep: firebase-admin)
    |
    +-- @nehorai/credits-nextjs      Next.js adapter (peer deps: next, next-auth)
```

The core package defines the `ICreditRepository` interface and `CreditsService`. Database adapters (like `credits-firestore`) implement the repository interface. Framework adapters (like `credits-nextjs`) provide authentication and server action integration.

## Quick Start

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
  operationCosts: { story_generation: 10, image_generation: 10 },
});
```

## Development

```bash
pnpm install     # Install dependencies
pnpm build       # Build all packages
pnpm test        # Run all tests
pnpm typecheck   # Type-check all packages
```

## License

MIT
