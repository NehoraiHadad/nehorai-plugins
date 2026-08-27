# @nehorai/credits-drizzle

Drizzle ORM (PostgreSQL) adapter for [`@nehorai/credits`](../credits).

Implements the full `ICreditRepository` surface plus the **V2 reservation
boundary**, which is what makes concurrent reserve / commit / release / expire
safe under real load.

```bash
npm install @nehorai/credits-drizzle drizzle-orm
```

## The V2 boundary

Every V2 transition runs in **one** database transaction that:

1. takes `SELECT … FOR UPDATE` on the reservation row, then the balance row —
   always in that order, so concurrent callers cannot deadlock;
2. compare-and-sets the status (`UPDATE … WHERE status = 'reserved'`), so
   exactly one caller can win a transition;
3. mutates the balance with **expressions** (`balance - $amount`), never a
   value read earlier — a stale read cannot overwrite a concurrent write;
4. writes **exactly one** journal entry, inside the same transaction, keyed by
   `reservation:<id>:<transition>` so a retry cannot duplicate it.

Losers get a typed outcome (`already_terminal`, `not_due`, `not_found`) rather
than an exception, so callers can tell "someone else won" from "it failed".
No callbacks or network calls happen inside the transaction.

```ts
import { DrizzleCreditRepository } from '@nehorai/credits-drizzle/repository'

const repo = new DrizzleCreditRepository(db)

const reserved = await repo.reserveCreditsV2({
  userId,
  amount: 40,
  operationType: 'story_generation',
  expiresAt: new Date(Date.now() + 15 * 60_000),
  idempotencyKey: `job:${jobId}`,   // optional; retries replay instead of double-charging
})

switch (reserved.outcome) {
  case 'created':              break                       // fresh hold
  case 'replayed':             break                       // same key, same payload
  case 'insufficient':         /* reserved.shortfall */    break
  case 'idempotency_conflict': /* key reused with a different amount/op */ break
}
```

`idempotencyKey` is optional. Omit it and you get the legacy behaviour: every
call places a new hold.

## Migration (required before V2 calls)

V2 needs two nullable columns and two **partial unique indexes**. Without the
indexes the adapter fails loudly on the first V2 reserve rather than silently
double-holding, so a half-applied migration cannot corrupt balances.

**drizzle-kit users:** `drizzle-kit generate` picks the change up from the
exported schema. Nothing else to do.

**Everyone else:** the SQL is exported.

```ts
import {
  CREDITS_V2_MIGRATION_SQL,          // columns + CONCURRENTLY indexes, in order
  CREDITS_V2_INDEXES_BLOCKING_SQL,   // same indexes, transactional but locks writes
  CREDITS_V2_CONSTRAINTS_SQL,        // optional CHECKs, added NOT VALID
  creditsV2MigrationScript,          // the whole thing as one pasteable script
} from '@nehorai/credits-drizzle/migrations'
```

```ts
// Run one statement at a time and OUTSIDE a transaction block.
for (const statement of CREDITS_V2_MIGRATION_SQL) {
  await db.execute(sql.raw(statement))
}
```

Notes that matter on a live table:

- Adding a nullable column with no default is metadata-only in PostgreSQL — it
  does not rewrite the table.
- The indexes use `CREATE UNIQUE INDEX CONCURRENTLY`, which **cannot run inside
  a transaction block**. Most migration runners wrap statements in one by
  default; opt out, or use `CREDITS_V2_INDEXES_BLOCKING_SQL` if a brief write
  lock is acceptable.
- The indexes are partial (`WHERE idempotency_key IS NOT NULL`), so existing
  rows — all with a NULL key — impose no constraint and cannot fail the build.
- Every statement is individually idempotent, so a partially applied migration
  is safe to re-run.
- `CREDITS_V2_CONSTRAINTS_SQL` is optional and adds its CHECKs `NOT VALID`, so
  it never scans existing rows. Audit the table, then promote them with
  `CREDITS_V2_VALIDATE_CONSTRAINTS_SQL`. It deliberately does **not** add
  `balance >= 0` — apps that booked corrections or overdrafts may hold
  legitimate negative rows.

## Behaviour changes in 0.2.0

Two observable changes for existing callers, both on the legacy methods that
now route through V2:

- **`releaseReservationAtomic` now writes a journal entry** (`amount: 0`,
  source `operation_release`, hold size in `metadata.amount`). Previously it
  released the hold silently. Reports that count journal rows will see more of
  them; reports that sum `amount` are unaffected.
- **Commit journals record `balanceAfter` as `balance + bonusCredits`.** The
  service layer previously wrote `balance` alone, which understated the figure
  for users holding bonus credits.

Also: the service layer no longer writes its own journal entry after a commit —
the repository writes the single authoritative one inside the transaction. If
you were relying on seeing two rows per commit, you will now see one.

## Testing

Unit and contract tests run without a database. The concurrency suite needs a
real PostgreSQL and is skipped when unset:

```bash
CREDITS_TEST_DATABASE_URL=postgres://user:pw@localhost:5432/db pnpm test
```

It creates and truncates its own tables, and applies the exported migration SQL
against a legacy schema — so the migration itself is under test, not just the
adapter.

## License

MIT
