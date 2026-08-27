# @nehorai/credits-drizzle

## 0.2.0

> An independent adversarial review blocked the first cut of this release. The
> **Release-blocker fixes** section below lists what it found and what changed;
> the rest of the entry describes the feature as a whole. Nothing shipped in
> between, so this is all one release.

### Release-blocker fixes

- **A V2 operation can no longer run outside a real transaction.** `withTx`
  used to fall back to running the callback directly when the handle had no
  `transaction` method, so a pool, a shim or a mock silently got every V2
  guarantee removed while still reporting success. It now refuses with
  `UNSUPPORTED_OPERATION` before any write, and additionally *proves* it is in
  a transaction by issuing a `SAVEPOINT` — which PostgreSQL rejects outside a
  transaction block — so a `transaction` method that does not actually open one
  is caught too. Passing an already-open transaction is supported and explicit:
  it goes through the same `db.transaction()` call, which opens a SAVEPOINT and
  therefore gives real partial rollback when the caller owns the outer
  transaction.
- **A failed concurrent index build is now detected and repaired.**
  `CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS` leaves an invalid index
  holding the name when it fails, so the retry skipped the build and reported
  success while nothing was enforced. `IF NOT EXISTS` is gone, and the new
  `runCreditsV2Migration` reads `pg_index` (`indisvalid`, `indisready`,
  `indislive`, `indisunique`), drops an unhealthy index concurrently, rebuilds
  it, and verifies the catalog afterwards. A build blocked by duplicate rows now
  fails with `CONFIGURATION_ERROR` naming the colliding keys instead of leaving
  a silent gap.
- **Balance invariants fail closed instead of clamping.** Commit, release and
  expire previously wrote `reserved = greatest(reserved - amount, 0)`. When
  `reserved` had drifted below a hold, that clamp zeroed the counter and
  consumed the coverage of every other live hold. All three now require
  `reserved >= amount` in the `WHERE`, roll back on violation, and report
  `DATABASE_ERROR` — deliberately not `INSUFFICIENT_CREDITS`, because it is
  corruption, not a user who ran out of money. The README documents the
  recompute-from-live-holds repair.
- **Journal collisions are validated in full.** An existing row under a
  deterministic journal key was accepted if only `reference_id` and `source`
  matched. It now must match on user, entry type, amount, balance-after,
  source, reference id, reference type and the deterministic metadata, with
  amounts compared as exact integer cents rather than floats. Anything else
  rolls the transition back with `DATABASE_ERROR` rather than reporting a
  charge the ledger does not record.
- **Errors are actually classified.** `classifyDatabaseError` existed but was
  never called. All four public V2 methods now route through it, so SQLSTATE
  `40001`, `40P01`, `55P03`, `57014`, `57Pxx` and class `08` surface as
  `TRANSIENT_ERROR`, other driver failures as `DATABASE_ERROR`, and deliberate
  `CreditError`s pass through unflattened. The ambiguity of a class `08` failure
  during COMMIT is documented rather than papered over.
- **Amounts are validated against `numeric(12, 2)`** before any write:
  non-finite, non-positive, over-precision and out-of-range values are rejected
  with `INVALID_AMOUNT` instead of being silently rounded by the column.
- **The expiry sweep can no longer be starved.** A reservation that fails to
  expire is recorded and excluded from the rest of the run, so a few corrupt
  rows at the head of every `LIMIT` cannot block the healthy rows behind them.
  The sweep also no longer stops when an entire batch fails: growing the
  exclusion list counts as progress, because the next query then reaches the
  healthy rows behind it.
- **The transaction probe requires an answer, not just the absence of an
  error.** A stub `execute` that resolves with nothing used to satisfy a
  statement-only savepoint check; the probe now asks the server to echo a token
  back. Separately, only SQLSTATE 25P01 (or an error carrying no SQLSTATE) is
  read as "no transaction here" — 25P02 and friends are passed through to the
  classifier instead of being reported as a bad handle.
- **The migration runner checks index identity, not just the name.** An index
  name is unique per schema across all relations, so a healthy unique index on
  the wrong table could occupy the name; the runner now compares `indrelid` and
  the index definition and refuses with `CONFIGURATION_ERROR` rather than
  skipping the build and passing its own verification.
- **Journal metadata is compared symmetrically.** A stored row that recorded a
  hold size the transition does not carry was accepted, because only the
  incoming side was checked for the field's presence.


**Requires a schema migration** (see README) and changes two observable
behaviours, hence the minor bump on a 0.x package rather than a patch.

### Added

- `@nehorai/credits-drizzle/migrations` now exports `runCreditsV2Migration` and
  `readIndexState` alongside the raw SQL.
- **V2 reservation boundary** — `reserveCreditsV2`, `commitReservationV2`,
  `releaseReservationV2`, `expireReservationV2`. Each runs in one transaction
  that locks the reservation row then the balance row (always in that order),
  compare-and-sets the status, mutates the balance with SQL expressions rather
  than a previously-read value, and writes exactly one journal entry keyed by
  `reservation:<id>:<transition>`. Losers get a typed outcome; there are no
  callbacks or network calls inside the transaction.
- `idempotency_key` columns on `credit_reservations` and
  `credit_journal_entries`, each with a partial unique index on
  `(user_id, idempotency_key) WHERE idempotency_key IS NOT NULL` — so existing
  NULL-key rows are unconstrained and legacy callers are unaffected.
- New `@nehorai/credits-drizzle/migrations` entry point exporting the migration
  SQL (`CREDITS_V2_COLUMNS_SQL`, `CREDITS_V2_INDEXES_SQL`,
  `CREDITS_V2_INDEXES_BLOCKING_SQL`, `CREDITS_V2_CONSTRAINTS_SQL`,
  `creditsV2MigrationScript`) for apps that do not use drizzle-kit — and the
  `runCreditsV2Migration` runner, which is the supported way to apply it.
- A PostgreSQL integration suite covering concurrent same-key reserves,
  competing reserves against limited funds, 50 concurrent commits of one
  reservation, commit-vs-release and commit-vs-expire races, rollback on an
  injected journal failure, and the migration applied over a populated legacy
  schema. Runs when `CREDITS_TEST_DATABASE_URL` is set; skipped otherwise.

### Fixed

- `commitReservationAtomic` read the reservation and balance without row locks
  or a status check, then wrote back literal values. Concurrent commits of the
  same reservation could deduct and journal twice, and two commits of
  *different* reservations could lose one of the deductions entirely. Both are
  now impossible: the status transition is a compare-and-set and the balance is
  mutated by expression.
- Commit, release, and expiry could race each other. Each is now a guarded
  transition with exactly one winner.
- `findAndExpireReservations` released holds and then wrote `status = 'expired'`
  in a separate step, outside one guarded transaction. It now calls the guarded
  `expireReservationV2` per row and stops if a pass makes no progress.
- `balanceAfter` in the journal came from a value read before the update. It now
  comes from the `UPDATE … RETURNING` row, so it cannot record a stale figure.

### Changed (breaking for consumers relying on the old side effects)

- **`releaseReservationAtomic` now writes a journal entry** (`amount: 0`, source
  `operation_release`, hold size in `metadata.amount`). It previously released
  the hold with no journal row. Reports counting journal rows will see more of
  them; reports summing `amount` are unaffected.
- **Commit journals record `balanceAfter` as `balance + bonusCredits`.** The
  service layer previously wrote `balance` alone, understating the figure for
  users holding bonus credits.
- **One journal entry per commit, not two.** The repository now writes the
  authoritative entry inside the transaction and the service layer no longer
  adds its own.
- **V2 requires a handle that can open a transaction and run raw SQL.** A
  handle without `transaction` used to be accepted (and silently run
  unprotected); it is now rejected with `UNSUPPORTED_OPERATION`. Real Drizzle
  databases and transactions both qualify; hand-rolled shims and mocks may not.
- Calling a V2 method before the migration has been applied throws
  (`there is no unique or exclusion constraint matching the ON CONFLICT
  specification`) rather than silently placing duplicate holds. This is
  deliberate: a half-applied migration fails loudly instead of corrupting
  balances.
