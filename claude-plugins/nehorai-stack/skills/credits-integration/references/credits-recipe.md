# Credits integration recipe (@nehorai/credits 2.x + drizzle)

The concrete wiring for a PostgreSQL app. Adapt names to the app; keep the
structure. For semantics and invariants, the installed package READMEs are the
authority (`node_modules/@nehorai/credits*/README.md`).

## 1. Install

```bash
pnpm add @nehorai/credits @nehorai/credits-drizzle drizzle-orm
```

The adapter's tables come from its exported Drizzle schema:

```ts
// db/schema.ts — re-export so drizzle-kit manages the plugin tables too
export * from '@nehorai/credits-drizzle/schema'
// creditBalances, creditReservations, creditPluginTransactions,
// creditJournalEntries — all under your normal migration flow
```

Run your schema migration first (creates tables + `payment_ref` column), then
the V2 migration once (indexes + `hold_placed_at` etc.):

```ts
import { runCreditsV2Migration } from '@nehorai/credits-drizzle/migrations'
await runCreditsV2Migration(db) // db handle, not a transaction; see SKILL.md checklist
```

## 2. Wire the repository and service

Configuration is a core-module singleton, initialized once at startup —
**before** any service call:

```ts
// credits/index.ts — one module owns config + instances
import { initializeConfig, createCreditsService } from '@nehorai/credits'
import { createDrizzleCreditRepository } from '@nehorai/credits-drizzle'
import { db } from '../db'

initializeConfig({
  operationCosts: { story_generation: 10, episode_generation: 25 },
  tierConfigs: {
    free:    { monthlyLimit: 25 },
    basic:   { monthlyLimit: 300 },
    premium: { monthlyLimit: 500 },
  },
  // optional: reservationExpiryMs, defaultFreeCredits,
  // subscriptionGracePeriodDays, lowBalanceThreshold, features {...}
})

export const creditsRepo = createDrizzleCreditRepository(db)
export const credits = createCreditsService(creditsRepo)
```

(`loadConfigFromEnv()` exists for env-driven overrides; `tierConfigSchema`
fields beyond `monthlyLimit` — confirm against the installed `.d.ts`.)

## 3. Charge for an operation (two-phase hold)

```ts
const chargeId = crypto.randomUUID()
const hold = await creditsRepo.reserveCreditsV2({
  userId,
  amount: cost,
  operationType: 'episode_generation',
  expiresAt: new Date(Date.now() + 15 * 60_000),
  idempotencyKey: `episode_generation:${chargeId}`,
})

switch (hold.outcome) {
  case 'created':
  case 'replayed':             break                    // proceed with the work
  case 'insufficient':         return outOfCredits(hold.shortfall)
  case 'idempotency_conflict': throw alarm(hold)        // key reused differently
}

try {
  await doTheExpensiveWork()
  await creditsRepo.commitReservationV2(userId, hold.reservation.id)
} catch (err) {
  await creditsRepo.releaseReservationV2(userId, hold.reservation.id)
  throw err
}
```

Both settle calls are idempotent; a retry that finds the row settled reports
`already_terminal` rather than moving money twice. Expired holds are returned
by the expiry path — never re-commit them.

## 4. Credit a purchase (webhook / verify-on-return)

One call, keyed by the provider's payment id. Deliveries can race and repeat;
the outcome says what happened:

```ts
const outcome = await creditsRepo.addCreditsV2({
  userId,
  amount: pack.credits,
  description: `Purchased ${pack.name}`,
  paymentRef: `sumit:${paymentId}`,       // global — one credit event per ref
})

switch (outcome.outcome) {
  case 'created':  break                  // credited now, exactly once
  case 'replayed': break                  // an earlier delivery already credited
  case 'conflict': await alertOps(outcome) // same ref, different amount/user — never retry
}
```

`addCreditsV2` raises `bonusCredits` (purchase credits survive the monthly
reset) and creates the account at tier defaults if the webhook outran user
provisioning.

## 5. Refunds (the protocol — there is no dedicated API)

A refund is a compensating credit event with its own global reference derived
from the charge:

```ts
const refund = await creditsRepo.addCreditsV2({
  userId,
  amount: refundedCredits,
  description: `Refund for ${chargeId}`,
  paymentRef: `refund:${chargeId}`,
})
// created | replayed → done (safe to retry the whole flow)
// conflict           → operator alarm: the ref was used with other parameters
```

Negative balances are allowed by design (corrections/overdrafts), so refunding
credits the user already spent is representable.

## 6. Monthly tiers, resets, downgrades

- `CreditsService` drives the monthly reset via the repository's
  `atomicMonthlyReset` (compare-and-set on `monthlyResetAt`, journal written
  in the same atomic step on adapters that support it).
- Subscription expiry downgrades through `checkAndHandleSubscriptionExpiry`;
  the balance clamps to the new limit **but never below open holds**.
- When fulfilment confirms a subscription cycle, update tier/limit/reset
  fields — do not `addCredits` for renewals (see SKILL.md non-negotiable 6).

## 7. Testing

Use `createInMemoryCreditRepository()` from core — same interface, same V2
outcomes, run-to-completion atomicity — so service-level tests need no
database. Integration-test the drizzle adapter against real PostgreSQL (the
package's own suite is the model: it runs 200+ tests against a live PG).

## 8. Known sharp edges (fast list)

- `createReservation` / `updateReservationStatus` are record-only — never a
  hold path (2.0.0 makes this loud: `UNSUPPORTED_OPERATION` /
  `UNBACKED_RESERVATION`).
- Raw SQL that lowers `balance` below `reserved - bonusCredits` strands holds.
- Off-cent amounts raise `INVALID_AMOUNT` — round first.
- `paymentRef` comparison is semantic: same ref + different payload =
  `conflict`, and the row keeps the original truth.
- The V2 migration refuses while any reservation is open; repair = release +
  decrement `credit_balances.reserved`, then re-run.
