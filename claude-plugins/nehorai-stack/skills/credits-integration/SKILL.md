---
name: credits-integration
description: >-
  Integrate the @nehorai/credits family (core 2.x + drizzle / firestore /
  nextjs adapters) into an app: user credit balances, monthly tiers with
  resets, idempotent payment crediting via paymentRef, and two-phase holds
  (reserve → commit/release) for paid operations. Use whenever the user adds a
  credits/quota/usage-billing system, wires "buy credits" fulfilment or
  refunds, debugs double-crediting or a stuck reservation, runs the V2
  PostgreSQL migration, or upgrades from credits 1.x — even if they only say
  "charge the user credits", "monthly quota", or "the webhook credited twice".
---

# @nehorai/credits integration

You are wiring the credits system into one of Nehorai's apps. The plugin owns
balances, holds, tiers, and the idempotency boundary; **products, prices, and
what an operation costs live in the app**. Payments are a separate family
(`@nehorai/payments` — see the `payments-integration` and `sumit-payments`
skills); the seam between them is exactly one call: `addCreditsV2` with the
payment's reference.

## Packages and compatibility (as of 2026-08-28)

| Package | Version | Role |
|---|---|---|
| `@nehorai/credits` | **2.0.0** | Core: types, `CreditsService`, `ICreditRepository`, in-memory repo, SDK |
| `@nehorai/credits-drizzle` | **0.2.0** | PostgreSQL adapter (Drizzle ORM), V2 migration runner. Depends on core `^2.0.0` |
| `@nehorai/credits-firestore` | **2.0.0** | Firestore adapter (legacy journaling path — the service journals for it). Depends on core `^2.0.0` |
| `@nehorai/credits-nextjs` | **2.0.0** | NextAuth / server-action wrapper. Depends on core `^2.0.0` |

**Choosing a stack:** new apps that need real idempotency guarantees should use
PostgreSQL + `credits-drizzle` — it is the only adapter whose uniqueness is
enforced by the database itself. The whole family is aligned on core 2.x (apps
still on adapter 1.x get core 1.x transitively and should upgrade together).
The in-memory repository is for tests only.

## Sources of truth (read before writing code)

- `references/credits-recipe.md` (next to this file) — the integration recipe:
  install, wiring, the V2 call patterns, and the refund protocol.
- **The installed package READMEs** — npm always ships them:
  `node_modules/@nehorai/credits/README.md` and especially
  `node_modules/@nehorai/credits-drizzle/README.md` (V2 boundary, migration,
  balance invariants, amounts, errors, 0.2.0 behaviour changes). These are
  version-matched to what the app actually installed — prefer them over memory.
- For exact API surfaces, read the `.d.ts` files in `node_modules` rather than
  guessing method names.

## The V2 idempotency boundary (why this exists)

Every mutation that must not happen twice goes through a V2 method that
resolves a caller-supplied key to an explicit outcome instead of throwing:

- **Crediting** — `addCreditsV2({ userId, amount, description, paymentRef })`
  → `created` | `replayed` | `conflict`. `paymentRef` is **global and
  semantic**: the same reference means the same credit event no matter who
  presents it; a redelivery with a *different* amount or user is `conflict`,
  not a replay. In SQL the arbiter is a partial unique index + `ON CONFLICT DO
  NOTHING` — real DB-level idempotency, not read-then-insert.
- **Holds** — `reserveCreditsV2({ userId, amount, operationType, expiresAt,
  idempotencyKey? })` → `created` | `replayed` | `insufficient` |
  `idempotency_conflict`, then `commitReservationV2` / `releaseReservationV2`
  (each idempotent, terminal states reported as `already_terminal`).
- **Key format**: `'{kind}:{uuid}'` per logical operation — e.g.
  `purchase:pay_123`, `refund:pay_123`, `episode_generation:9f3c…`. Never a
  constant like `episode_generation:pending`.
- **Refunds**: there is no dedicated refund API; `addCreditsV2` with
  `paymentRef: 'refund:{chargeId}'` is the protocol. `created`/`replayed` =
  success (retry-safe); `conflict` = alarm for an operator, never retry it.

## Non-negotiables (each one is an audited failure mode)

1. **Never place a hold with `createReservation`.** It is a record-only API:
   it never raises `reserved`, refuses an `idempotencyKey`, and every
   commit/release/expire refuses its rows with `UNBACKED_RESERVATION`. Holds
   come only from `reserveCreditsV2` / `reserveCreditsAtomic` (the latter is a
   direct delegate of V2 in 2.x — legacy callers are drop-in compatible).
   Likewise `updateReservationStatus` refuses live holds and refuses writing
   `reserved`; two-phase-commit built on those two methods must migrate.
2. **Treat `conflict` / `idempotency_conflict` as alarms, not retries.** They
   mean the key was reused with different parameters — retrying can only
   repeat the mismatch or mask a bug.
3. **Never write `balance` below `reserved - bonusCredits`** (the
   `backedBalanceFloor`). Doing so strands every open hold at
   `INSUFFICIENT_CREDITS` forever. The library floors its own writers (monthly
   reset, subscription downgrade, `updateUserTier`); a raw SQL/console write
   that ignores the floor recreates the bug.
4. **Amounts live on the cent grid.** `1.005`, `Infinity`, and float residue
   (`0.1 + 0.2`) raise `INVALID_AMOUNT` — round to cents before calling.
5. **Don't consume the payment boundary with records.** `createTransaction`
   refuses a `paymentRef` by design; only `addCreditsV2` may claim one.
6. **One-time purchases are bonus credits; subscription cycles are not.**
   `addCredits*` raises `bonusCredits` (survives monthly reset). Monthly
   allowance reloads go through tier/limit updates and the reset machinery —
   never mint a renewal with `addCredits`.

## PostgreSQL migration (required before any V2 call)

Use the runner — it verifies the catalog field-by-field and refuses drift:

```ts
import { runCreditsV2Migration } from '@nehorai/credits-drizzle/migrations'
const report = await runCreditsV2Migration(db) // a db handle, NOT a transaction
```

Checklist for a production run:
- The `payment_ref` column on `credit_plugin_transactions` must already exist
  (it comes from the package's Drizzle schema via your normal schema
  migration); the runner verifies it and stops with `CONFIGURATION_ERROR` if
  missing or mistyped.
- Default mode builds indexes `CONCURRENTLY` — it cannot run inside a
  transaction block; most migration tools need an explicit opt-out.
- **Hard precondition: zero open (`status = 'reserved'`) reservations.** The
  migration refuses and rolls back otherwise. Repair = release/expire each open
  row AND decrement `credit_balances.reserved` by its amount, then re-run.
- The column/backfill phase holds ACCESS EXCLUSIVE on `credit_reservations`
  through the backfill in either mode — plan a short write-blocking window.

## Upgrading an app from core 1.x

`2.0.0` is a major because `createReservation` became loudly record-only (see
non-negotiable 1). Everything else is compatible: the service API, the atomic
family, journal shapes, and `addCreditsAtomic` (which since 1.7 accepts journal
`source` + `metadata`). Audit the app for `createReservation` /
`updateReservationStatus` used as a hold path — that is the entire migration
surface. Then run the V2 migration before the first V2 call.
