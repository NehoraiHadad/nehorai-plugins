# @nehorai/credits

Monorepo for the `@nehorai/credits` package family -- a framework-agnostic credits/billing system.

## Packages

| Package | Description |
|---------|-------------|
| [`@nehorai/credits`](./packages/credits) | Core credit system: types, service, in-memory repository |
| [`@nehorai/credits-firestore`](./packages/credits-firestore) | Firestore adapter for the credit repository |
| [`@nehorai/credits-nextjs`](./packages/credits-nextjs) | Next.js adapter: NextAuth integration, `withCredits` HOF |

## Development

```bash
pnpm install
pnpm build
pnpm test
```

## License

MIT
