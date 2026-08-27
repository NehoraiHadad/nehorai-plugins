# @nehorai/credits-drizzle

Drizzle ORM (PostgreSQL) adapter for [`@nehorai/credits`](../credits).

Implements the full `ICreditRepository` surface plus the **V2 reservation
boundary**, which is what makes concurrent reserve / commit / release / expire
safe under real load.

```bash
npm install @nehorai/credits-drizzle drizzle-orm
```

## The V2 boundary

Every V2 transition runs in **one** database transaction. `reserveCredits` is
the one that mints a hold, so it has no reservation row to lock, no status to
compare-and-set and no ledger movement to journal; it inserts under the partial
unique index on `(user_id, idempotency_key)` and lets PostgreSQL arbitrate. The
three that end a hold — commit, release and expire — each:

1. take `SELECT … FOR UPDATE` on the reservation row, then the balance row —
   always in that order, so two of *these* transitions cannot deadlock against
   each other. It is not an absolute guarantee: a caller-owned outer transaction
   that has already locked one of those rows in the other order still can, and
   that surfaces as a classified, retryable `TRANSIENT_ERROR`, not as a raw
   40P01;
2. compare-and-set the status (`UPDATE … WHERE status = 'reserved'`), so
   exactly one caller can win a transition;
3. mutate the balance with **expressions** (`balance - $amount`), never a
   value read earlier — a stale read cannot overwrite a concurrent write;
4. write **exactly one** journal entry, inside the same transaction, keyed by
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

V2 needs three nullable columns (`idempotency_key` on `credit_reservations`
and `credit_journal_entries`, and `hold_placed_at` on `credit_reservations`)
and three **partial unique indexes** — the two idempotency keys, and
`payment_ref` on `credit_plugin_transactions`, which the credit path
deduplicates through. Without them the adapter fails loudly on the first V2
reserve or referenced credit rather than silently double-holding or
double-crediting, so a half-applied migration cannot corrupt balances.

**Use the runner.** It is the supported path:

```ts
import { runCreditsV2Migration } from '@nehorai/credits-drizzle/migrations'

const report = await runCreditsV2Migration(db)   // db, NOT a transaction
console.log(report.steps)                        // every statement it ran
console.log(report.indexes)                      // the catalog state it confirmed
```

### What the migration verifies

The runner does not trust names — its own included. Before it builds anything it
reads the catalog and compares identity field by field:

- **Columns.** `idempotency_key`, `hold_placed_at` and `payment_ref` must exist
  with the exact type, be nullable, and have no `DEFAULT`, generated expression
  or identity. A `varchar(20)` key truncates the value uniqueness is enforced
  on; a `DEFAULT now()` on `hold_placed_at` would forge the hold-origin fact for
  every row that never had a hold. Either one stops the run with
  `CONFIGURATION_ERROR` naming the column and the mismatch.
- **Indexes.** Table, uniqueness, access method, key columns in order, attribute
  count and the deparsed partial predicate. An index that owns one of these
  names without being the right index is reported, never dropped.
- **CHECK constraints.** The optional constraints in
  `CREDITS_V2_CONSTRAINTS_SQL` are not applied by the runner, but one that
  exists under our name while checking something else is drift that reads as
  safety — so its `pg_get_constraintdef` is compared and a mismatch stops the
  run. `NOT VALID` is reported separately as `validated: false` rather than
  treated as a difference.

`report.columns` and `report.constraints` carry what was confirmed, alongside
`report.indexes`.

### `hold_placed_at` and the backfill

`hold_placed_at` records that a row's hold was placed atomically:
`reserveCreditsV2` writes it in the same transaction that raises
`credit_balances.reserved`, and nothing else writes it. Every V2 transition
refuses a row without it, and no such row can be adopted as an idempotent
replay — otherwise a row written by `createReservation`, which never touches
`reserved`, would be committed against another reservation's coverage.

The migration adds the column and backfills existing rows from `created_at` in
the same step, once. Reservations a deployment is already holding therefore keep
working, while a NULL that appears *after* the column exists — which is exactly
what the guard is for — is never blessed by a later run.

### Why a runner and not just SQL

`CREATE UNIQUE INDEX CONCURRENTLY` is not atomic. If the build fails — a
duplicate key, a cancelled statement, a crashed backend — PostgreSQL leaves the
index behind with `indisvalid = false`. It enforces nothing, but it **owns the
name**, so the obvious retry with `IF NOT EXISTS` matches that name, skips the
build and reports success. The migration then says "applied" while the
uniqueness the V2 boundary depends on does not exist.

Nothing in plain SQL detects that. The runner reads `pg_index` for
`indisvalid`, `indisready` and `indislive`, and stops with a
`CONFIGURATION_ERROR` when an index fails any of them — naming the index, the
state it is in, and the `DROP INDEX` an operator should run before re-running
the migration. It does not drop and rebuild it itself; see **The runner never
drops an index** below for why. A build that fails on live duplicate data throws
a `CONFIGURATION_ERROR` listing the colliding `(user_id, idempotency_key)`
groups so you can repair the data, and the runner refuses to report success on
an index that is not healthy.

The runner also checks *identity*, not just health. An index name is unique per
schema across every relation, so a perfectly valid unique index can occupy the
name on the wrong table — or cover the wrong columns, or the right columns in
the wrong order, or carry a different predicate. The runner reads the catalog
field by field: the table it is attached to (compared as the deparsed
`indrelid::regclass` name, not as a raw OID — so it is exact for an unambiguous
name and inherits whatever `search_path` resolved), `indisunique`, the access
method, the total attribute count (so an `INCLUDE` column cannot slip through),
each key column via `pg_get_indexdef(oid, n, true)` (which emits a bare column
name only when opclass, collation, sort direction and null ordering are all
default), and the partial predicate. Anything that does not match exactly is a
`CONFIGURATION_ERROR`.

**The runner never drops an index — any index, for any reason.** It used to drop
and rebuild one it judged unusable, which is a read-then-drop by name: PostgreSQL
re-resolves the name when `DROP INDEX` runs, so a session renaming indexes in
between could redirect it onto an unrelated one. There is no drop that targets an
OID, so instead the runner stops and tells the operator exactly what it found and
what to drop. `MigrationReport.repaired` is retained but is always empty.

The comparison is deliberately conservative in one direction: a semantically
equivalent index written differently — `WHERE NOT (idempotency_key IS NULL)`
deparses differently from `WHERE idempotency_key IS NOT NULL` — is reported as
a mismatch. That errs towards telling you, and **the runner never drops or
replaces an index it does not recognise as its own.**

Inspect state yourself with `readIndexState(db, name)` — it reports the table,
key columns, predicate and catalog flags, plus `matchesSpec` and a `mismatch`
description when it disagrees.

### Running it from more than one place

Two runners starting at once used to deadlock: one succeeded and the other saw
a raw SQLSTATE 40P01. By default `runCreditsV2Migration` now runs the whole
migration inside **one transaction that first takes a transaction-scoped
advisory lock**, so concurrent callers queue instead of colliding — the loser
wakes up, finds the exact index it wanted, and reports `skip`. `db.transaction()`
pins one physical connection, which is what makes the lock meaningful on a pool.

The cost is that this path cannot use `CONCURRENTLY` (it refuses to run inside a
transaction block), so writes to `credit_reservations` and
`credit_journal_entries` block for the duration. On a large live table, pass
`{ concurrent: true }`:

```ts
await runCreditsV2Migration(db, { concurrent: true })
```

That takes **no advisory lock at all** — there is no way to pin a pool
connection outside a transaction, so the lock would be meaningless. It builds
without blocking writes and, in exchange, gives up the coordination
so **you must ensure only one runner executes at a time**. A second runner that
starts while a `CONCURRENTLY` build is in flight will see `indisvalid = false`
and stop with a `CONFIGURATION_ERROR` — typed, but not something to retry
blindly.

Neither mode drops anything, in either case for the same reason: a repair would
mean reading the catalog and then issuing `DROP INDEX <name>`, and PostgreSQL
re-resolves that name when the statement runs. A session renaming indexes in
between can redirect the drop onto an unrelated index. Locking the parent table
does not prevent it — measured against PostgreSQL 14.24, `ALTER INDEX ... RENAME`
takes its lock on the index relation and completes while `ACCESS EXCLUSIVE` is
held on the heap. SQL has no drop that targets an OID, so the runner refuses and
hands the operator the identity it found instead.

Two further things it does **not** promise. It resolves every table through
`search_path`, exactly as the DDL does — it migrates and verifies the schema your
connection points at, and has no idea which schema you *meant*. And it wants a
root database handle: hand it an already-open transaction and the advisory lock
is held until your outer transaction commits, and conflicting lock orders can
still deadlock. That surfaces as a classified `TRANSIENT_ERROR` rather than a raw
40P01 — nothing leaves this function unclassified, including a missing base table
— but the way to not have it is to give the runner its own connection.

**drizzle-kit users:** `drizzle-kit generate` picks the columns and indexes up
from the exported schema, and that is *not* a substitute for the runtime catalog
check. Generating DDL says what the schema should be; only reading `pg_index`
says what it is. drizzle-kit cannot see an index that exists but is invalid, or
one whose name is occupied by a different index entirely. Run the runner — or at
minimum `readIndexState` — before enabling V2.

The raw SQL is still exported for migration tools that need to embed it. **It
is not individually idempotent and not safe to run twice or in parallel** — the
index builds carry no `IF NOT EXISTS` on purpose (that clause is what makes a
failed concurrent build unrecoverable), so re-running raises `42P07`, and two
copies at once can deadlock. Reconciliation and coordination live in the runner,
not in the strings:

```ts
import {
  CREDITS_V2_COLUMNS_SQL,
  CREDITS_V2_INDEXES_SQL,            // CONCURRENTLY; outside a transaction, once
  CREDITS_V2_INDEXES_BLOCKING_SQL,   // transactional, but locks writes
  CREDITS_V2_CONSTRAINTS_SQL,        // optional CHECKs, added NOT VALID
  creditsV2MigrationScript,          // the whole thing as one pasteable script
} from '@nehorai/credits-drizzle/migrations'
```

Notes that matter on a live table:

- Adding a nullable column with no default is metadata-only in PostgreSQL — it
  does not rewrite the table.
- `CREATE`/`DROP INDEX CONCURRENTLY` **cannot run inside a transaction block**.
  If you embed `CREDITS_V2_INDEXES_SQL` yourself, most migration runners open a
  transaction by default; opt out, or embed
  `CREDITS_V2_INDEXES_BLOCKING_SQL` instead if a brief write lock is
  acceptable. `runCreditsV2Migration`'s default path already uses the blocking
  form, for the coordination reasons above.
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
`SAVEPOINT` (which PostgreSQL rejects outside a transaction block with SQLSTATE
25P01) and then asking the server to echo a token back, so a stub `execute` that
merely resolves is caught too.

Two limits of that probe, stated rather than glossed over. Only SQLSTATE 25P01
is read as "no transaction here"; everything else — 25P02 from an already-aborted
transaction, a codeless error from a hand-rolled shim, a connection failure — is
rethrown unchanged rather than blaming your
handle. And a fake that faithfully impersonates PostgreSQL, accepting the
savepoint and echoing the token, will pass: the guarantee is "a database ran
this, inside a transaction block", not "this object is trustworthy".

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
finite, or above `9999999999.99` is rejected with `INVALID_AMOUNT` before any
row is touched, rather than silently rounded on the way in. Amounts that *move*
must also be strictly positive; amounts that are only *recorded* — a release
journals `amount: 0`, and `balanceAfter` is negative on a corrected account —
are checked for representability alone.

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

Observable changes for existing callers, all on the legacy methods that now
route through V2:

- **`releaseReservationAtomic` now writes a journal entry** (`amount: 0`,
  source `operation_release`, hold size in `metadata.amount`). Previously it
  released the hold silently. Reports that count journal rows will see more of
  them; reports that sum `amount` are unaffected.
- **Commit journals record `balanceAfter` as `balance + bonusCredits`.** The
  service layer previously wrote `balance` alone, which understated the figure
  for users holding bonus credits.
- **A `paymentRef` that names a different credit event is refused.**
  `addCreditsAtomic` used to return silently when the reference already
  existed, whoever it belonged to — which reads to the caller as "credited". It
  now throws `IDEMPOTENCY_CONFLICT` when the stored event differs (user,
  amount, type or source) and still returns quietly on a genuine replay. Use
  `addCreditsV2` to handle the three outcomes instead of catching.
- **`createReservation` refuses an `idempotencyKey`** with
  `UNSUPPORTED_OPERATION`. It writes a row without placing a hold, so a key
  there named a hold it never placed. Place idempotent holds with
  `reserveCreditsV2`.
- **A reservation whose `hold_placed_at` is NULL cannot be transitioned**
  (`UNBACKED_RESERVATION`). The migration backfills every row that predates the
  column, so this only affects rows written without a hold after the upgrade.
- **The monthly reset repairs a degraded unlimited balance** instead of leaving
  it untouched: it writes `greatest(balance, sentinel)`, so an unlimited
  account sitting at 0 recovers and a topped-up one is not cut down.

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
