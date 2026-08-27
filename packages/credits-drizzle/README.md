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

**Use the runner.** It is the supported path:

```ts
import { runCreditsV2Migration } from '@nehorai/credits-drizzle/migrations'

const report = await runCreditsV2Migration(db)   // db, NOT a transaction
console.log(report.repaired)                     // indexes it had to rebuild
```

### Why a runner and not just SQL

`CREATE UNIQUE INDEX CONCURRENTLY` is not atomic. If the build fails — a
duplicate key, a cancelled statement, a crashed backend — PostgreSQL leaves the
index behind with `indisvalid = false`. It enforces nothing, but it **owns the
name**, so the obvious retry with `IF NOT EXISTS` matches that name, skips the
build and reports success. The migration then says "applied" while the
uniqueness the V2 boundary depends on does not exist.

Nothing in plain SQL detects that. The runner reads `pg_index` for
`indisvalid`, `indisready`, `indislive` and `indisunique`, drops an index that
fails any of them (`DROP INDEX CONCURRENTLY`), rebuilds it, and re-reads the
catalog to confirm. If the rebuild still fails it throws a
`CONFIGURATION_ERROR` listing the colliding `(user_id, idempotency_key)` groups
so you can repair the data, and it refuses to report success on an index that
is not healthy.

Inspect state yourself with `readIndexState(db, name)`.

**drizzle-kit users:** `drizzle-kit generate` picks the columns and indexes up
from the exported schema. Run the runner anyway — or at minimum check
`readIndexState` — before enabling V2, since drizzle-kit has the same blind
spot about an index that exists but is invalid.

The raw SQL is still exported for migration tools that need to embed it:

```ts
import {
  CREDITS_V2_COLUMNS_SQL,
  CREDITS_V2_INDEXES_SQL,            // CONCURRENTLY; outside a transaction
  CREDITS_V2_INDEXES_BLOCKING_SQL,   // transactional, but locks writes
  CREDITS_V2_CONSTRAINTS_SQL,        // optional CHECKs, added NOT VALID
  creditsV2MigrationScript,          // the whole thing as one pasteable script
} from '@nehorai/credits-drizzle/migrations'
```

Notes that matter on a live table:

- Adding a nullable column with no default is metadata-only in PostgreSQL — it
  does not rewrite the table.
- `CREATE`/`DROP INDEX CONCURRENTLY` **cannot run inside a transaction block**.
  Most migration runners open one by default; opt out, or pass
  `{ concurrent: false }` if a brief write lock is acceptable.
- The indexes are partial (`WHERE idempotency_key IS NOT NULL`), so existing
  rows — all with a NULL key — impose no constraint and cannot fail the build.
- The index SQL deliberately has **no `IF NOT EXISTS`**. That clause is exactly
  what turns a failed build into a silent success; the runner's catalog check
  replaces it.
- `CREDITS_V2_CONSTRAINTS_SQL` is optional and adds its CHECKs `NOT VALID`, so
  it never scans existing rows. Audit the table, then promote them with
  `CREDITS_V2_VALIDATE_CONSTRAINTS_SQL`. It deliberately does **not** add
  `balance >= 0` — apps that booked corrections or overdrafts may hold
  legitimate negative rows.

## The database handle

V2 requires a handle that can open a transaction **and** execute raw SQL. Pass
a Drizzle database, or an already-open transaction:

```ts
await db.transaction(async (tx) => {
  const repo = new DrizzleCreditRepository(tx)   // supported: opens a SAVEPOINT
  await repo.commitReservationV2(userId, reservationId)
})
```

Both go through `db.transaction()` — a BEGIN on a root database, a SAVEPOINT on
an open transaction. The savepoint matters: when you own the outer transaction,
an error from this adapter must still undo *its* writes even if you catch that
error and commit anyway. A handle with no `transaction` method is refused with
`UNSUPPORTED_OPERATION` before anything is written, and so is one whose
`transaction` does not actually open one — the adapter proves it by issuing a
`SAVEPOINT`, which PostgreSQL rejects outside a transaction block.

## Balance invariants

Every transition requires `reserved >= amount` and refuses otherwise, rolling
back and raising `DATABASE_ERROR`. It does **not** clamp with
`greatest(reserved - amount, 0)`: if `reserved` has drifted below a hold, that
clamp would zero the counter and silently consume the coverage of every *other*
live hold, so their commits would later fail or overdraw.

If a user is wedged by a drifted counter, recompute it from the live holds:

```sql
UPDATE credit_balances b
SET reserved = coalesce((
      SELECT sum(amount) FROM credit_reservations r
      WHERE r.user_id = b.user_id AND r.status = 'reserved'
    ), 0)
WHERE b.user_id = $1;
```

Do that with the affected user's writers quiesced, and record it — this is a
correction to a ledger, not a routine repair.

## Amounts

Amounts live in `numeric(12, 2)`. Anything not exactly on the cent grid, not
finite, not positive, or above `9999999999.99` is rejected with
`INVALID_AMOUNT` before any row is touched, rather than silently rounded on the
way in.

## Errors

Every public V2 method normalises what escapes it into a `CreditError`.
SQLSTATE `40001`, `40P01`, `55P03`, `57014`, `57Pxx` and class `08` become
`TRANSIENT_ERROR`; other driver failures become `DATABASE_ERROR`; and an error
this adapter raised deliberately — `INSUFFICIENT_CREDITS`,
`IDEMPOTENCY_CONFLICT`, `INVALID_AMOUNT`, `UNSUPPORTED_OPERATION`, or an
invariant `DATABASE_ERROR` — passes through unchanged rather than being
flattened into a generic failure.

One caveat worth stating plainly: a class `08` connection failure is reported as
`TRANSIENT_ERROR`, but if the connection dropped *during* COMMIT the operation
may in fact have succeeded. Retrying is safe for the transitions (the status CAS
makes them idempotent) and for reserve **only when you pass an
`idempotencyKey`**. Without one, a retried reserve can place a second hold.

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
