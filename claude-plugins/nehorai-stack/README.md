# nehorai-stack (Claude Code plugin)

Agent skills for integrating the `@nehorai/*` npm package family into any
project. Installing this plugin gives Claude Code the distilled integration
knowledge — API contracts, invariants, migration checklists, and the sharp
edges that have actually burned us — so it wires the packages correctly
without rediscovering them.

## Skills

| Skill | Covers |
|---|---|
| `credits-integration` | `@nehorai/credits` 2.x + drizzle/firestore/nextjs adapters: balances, holds (reserve/commit/release), idempotent crediting via `paymentRef`, refunds, the V2 PostgreSQL migration, 1.x → 2.x upgrade |
| `payments-integration` | `@nehorai/payments` base + provider adapters (Stripe, SUMIT, Hyp, Cardcom), persistence and Next.js layers, webhook → fulfilment shape |
| `sumit-payments` | SUMIT (UPAY) hosted checkout end to end: verify-on-return grant path, subscriptions (Flow B), test-org setup, the full gotcha list |

Skills trigger automatically when a task matches (e.g. "add a credits system",
"the webhook credited twice", "wire SUMIT checkout") — no manual invocation
needed.

## Install (in any project)

```
/plugin marketplace add NehoraiHadad/nehorai-plugins
/plugin install nehorai-stack@nehorai-plugins
```

For local development of the marketplace itself:

```
/plugin marketplace add C:\projects\nehorai-plugins
```

## Keeping it honest

Each skill points agents at the **installed** package READMEs and `.d.ts`
files in `node_modules` for exact, version-matched API surfaces; the skill
bodies carry the semantics and invariants that don't change per patch. When a
package gains a breaking change, update the matching skill in the same PR.

The `sumit-payments` skill also exists at `.claude/skills/sumit-payments`
(project-local copy for work inside this monorepo). Keep the two in sync when
editing either.
