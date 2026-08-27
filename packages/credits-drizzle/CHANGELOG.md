# @nehorai/credits-drizzle

## 0.2.0

> Two independent adversarial reviews blocked this release before it shipped,
> and a third, fully external audit (Codex) blocked it again after that.
> **Thirteenth review pass** lists what the external audit found; **Second
> review pass** lists what the second one found; **Release-blocker fixes**
> lists the first. The rest of the entry describes the feature as a whole.
> Nothing shipped in between, so this is all one release.

### Fifteenth review pass (third external audit)

- **The migration refuses to run while any open reservation exists.** No query
  can prove *per row* whether a legacy `status = 'reserved'` row was a genuine
  hold or a `createReservation` record — aggregate arithmetic passes
  offsetting corruption, and a pre-lock check can be outrun by a live legacy
  writer. So the previous pass's reconciliation heuristic is gone: the
  `ADD COLUMN` now runs *first* and takes its ACCESS EXCLUSIVE lock, the
  open-row check runs under that lock (nothing can insert between the check
  and the backfill), and any open row refuses the whole migration — rolling
  the `ADD COLUMN` back with it. The backfill then provably stamps only
  terminal rows, which no transition ever moves. **Operational note:** release
  or expire every open reservation before migrating; reservations are
  short-lived by design (every row carries `expires_at`).
- **Subscription expiry decides under the row lock.** Eligibility was decided
  from an unlocked read and the downgrade UPDATE was predicated on `user_id`
  alone — so a renewal committing in between was overwritten (account
  downgraded, its new expiry cleared), and two concurrent expiry workers both
  reported `wasDowngraded: true`, duplicating journal lines and notifications.
  The whole check-and-downgrade now runs in one transaction against a row
  locked `FOR UPDATE`: a renewal that committed first is visible, one that
  arrives later queues behind the lock, and a second worker re-reads the
  downgraded row and passes. Raced regression: four concurrent workers, one
  downgrade.
- **The reset CAS is exact again.** The previous pass compared
  `Date.getTime()` values, which collapse timestamps differing by less than a
  millisecond — a stale expectation could pass against a value that had in
  fact changed. The CAS is back in the UPDATE's WHERE clause, evaluated by
  PostgreSQL at full microsecond precision, while keeping the row lock and the
  in-transaction journal. A mismatch refuses (the conservative direction);
  the application's own writes are millisecond-precision JS dates and always
  round-trip to an exact match. Regression: a stored value with microseconds
  the driver cannot represent refuses instead of resetting.

### Fourteenth review pass (external re-audit)

- **Subscription expiry can no longer re-mint spent credits.** The downgrade
  read the account, then wrote `Math.min(balance, limit)` back as a literal —
  so a commit landing between the read and the write had its spend restored by
  the stale write-back. The clamp target is now `least(balance, limit)`
  computed by PostgreSQL from the row's own columns inside the UPDATE, floored
  at the hold backing on the same terms as `updateUserTier`.
- **The monthly reset journals inside its own transaction.** The journal was a
  separate service call after the reset returned — a failure there landed
  after the CAS was consumed and the line was lost for good. The reset now
  locks the row `FOR UPDATE`, performs the CAS, the balance write and the
  journal INSERT in one transaction, and returns `journaled: true` so the
  service skips its non-atomic call. The lock also means the balance is
  derived from a row no concurrent reserve or commit can move.
- **The `hold_placed_at` backfill certifies on evidence, not on faith.** It
  unconditionally blessed every pre-column reservation row as a hold; a row
  `createReservation` wrote without placing a hold would then let a commit
  spend coverage no hold ever placed. The backfill now reconciles first: for
  each user, open rows must sum exactly to `credit_balances.reserved` (every
  genuine hold added its amount there; every record added nothing). Any
  mismatch refuses the whole migration — rolling back the `ADD COLUMN` too —
  and names the repair; a reconciled ledger migrates as before.
- **Repair-hint identifiers are escape-quoted.** An embedded `"` in a schema
  or index name is doubled before quoting, so the `DROP INDEX` hint cannot be
  malformed SQL.

### Thirteenth review pass (external audit)

- **A refused payment no longer creates the account it refused to credit.**
  `addCreditsV2` ensured the `credit_balances` row *before* the reference
  arbiter decided, and returned the `replayed`/`conflict` resolution normally —
  which COMMITTED the transaction, account row and all. A rejected delivery for
  a brand-new user therefore still created (and defaulted) an account. The
  resolution is now thrown out of the transaction as a sentinel and returned
  from outside it, so a replay or conflict rolls back every write. Proven
  against real PostgreSQL: a conflicting delivery for an unknown user leaves
  zero rows behind.
- **The same direct-writer guards as the core, enforced against the row.**
  `createTransaction` refuses a non-blank `paymentRef`
  (`UNSUPPORTED_OPERATION`) and normalises what it stores;
  `updateReservationStatus` reads the row, refuses one carrying
  `hold_placed_at`, refuses the `reserved` status outright, and additionally
  predicates its UPDATE on `hold_placed_at is null` so the refusal holds even
  against a row it read before a concurrent writer touched it
  (`hold_placed_at` is immutable, so the predicate cannot misfire).
- **Balance reductions are floored inside the UPDATE.** The monthly reset and
  `updateUserTier` now clamp the written balance at
  `greatest(reserved - bonus_credits, 0)`, computed by PostgreSQL from the
  row's own columns in the same statement — so the floor cannot race a
  concurrent reserve. Matches the core's new `backedBalanceFloor`.
- **`ensureUserCredits` creates at the configured default tier**
  (`getDefaultTier()`), not a hard-coded `'free'`, matching the in-memory
  adapter and the tier config.
- **The unusable-index hint is schema-qualified.** The repair hint for an
  INVALID index printed `DROP INDEX <name>` bare, so an operator pasting it
  with a different `search_path` could drop a same-named index in another
  schema. The catalog read now records the schema and the hint prints
  `DROP INDEX "schema"."name"`.

### Twelfth review pass

- **`hold_placed_at`, the fact that makes a row a hold.** `reserveCreditsV2`
  writes it in the same transaction that raises `credit_balances.reserved`, and
  nothing else writes it — so a row carrying it is proof that the hold behind it
  exists. Rows written by `createReservation` (which never touches `reserved`)
  are refused by every V2 transition and can never be adopted as a replay; the
  path that used to accept one committed credits that no hold ever covered, by
  spending a *different* reservation's coverage. The migration adds the column
  with a one-shot backfill from `created_at`, so reservations a deployment
  already holds keep working, while a NULL that appears after the column exists
  is never blessed by a re-run.
- **`paymentRef` is decided by the unique index, before the balance moves.**
  `addCreditsV2` inserts the transaction row with `ON CONFLICT (payment_ref) DO
  NOTHING` and only then credits, so a redelivery — including two that land on
  different connections at the same instant — resolves to `replayed` or
  `conflict` having written nothing. The previous implementation resolved it with
  a `SELECT` before crediting, which two concurrent callers both won. A
  reference is compared on its payload rather than on its presence, so the same
  reference for a different user, amount or source is a refusal rather than a
  silent no-op, and `addCreditsAtomic` throws `IDEMPOTENCY_CONFLICT` instead of
  returning as though it had credited. The conflict clause is attached only when
  a reference is present: an unreferenced credit never depends on the index,
  while a referenced one does — and a missing or drifted index fails the call
  with SQLSTATE 42P10 rather than quietly duplicating the reference.
- **The migration verifies identity, not names.** Column type, nullability,
  default, generated and identity attributes are read from the catalog for every
  V2 column, and named CHECK constraints are compared through
  `pg_get_constraintdef`; anything that owns one of our names while being
  something else stops the run with `CONFIGURATION_ERROR` before an index is
  built. A `DEFAULT now()` on `hold_placed_at` is refused specifically, because
  it would forge the hold-origin fact for every row. The
  `credit_plugin_transactions_payment_ref_unique` index is now one of the
  verified objects, since the credit path depends on it. New exports:
  `V2_COLUMNS`, `V2_CONSTRAINTS`, `readColumnState`, `readConstraintState`,
  `verifyColumns`, `verifyConstraints`, `verifyIndexes`, and `MigrationReport`
  gained `columns` and `constraints`.
- **A corrupt persisted `status` is quarantined, not cast**, on the same terms
  as the in-memory adapter: `CORRUPT_RESERVATION_STATUS`, ahead of the
  `already_terminal` and `not_due` exits, changing nothing.
- **The monthly reset repairs a degraded unlimited balance.** It used to leave
  an unlimited balance strictly alone, so an account whose balance had been
  written as `0` stayed there through every reset while the in-memory adapter
  recovered. It now writes `greatest(balance, sentinel)`, which restores a
  degraded account without cutting down a topped-up one.
- **Internal layout.** `migrations/runner.ts` was split into `runner.ts`,
  `errors.ts`, `verify.ts` and `columns.ts`, and the credit path moved to
  `repository/add-credits.ts`.

### Sixth review pass

- **`addCreditsAtomic` and `deductCreditsAtomic` name the value that actually
  failed.** Both mutated with column expressions, so the only thing that could
  catch an unstorable result was SQLSTATE 22003 — which does not say which
  expression produced it. `addCredits` therefore reported every overflow as
  `field: 'bonusCredits'`, including the common case where `bonus_credits +
  amount` fits perfectly well and it is the derived *total* recorded on the
  transaction and journal rows that does not. Both now take `SELECT … FOR
  UPDATE` on the balance row, compute each derived value, validate it under its
  own name (`previousBalance`, `balance`, `bonusCredits`, `newBalance`), and
  write literals. Atomicity is unchanged — concurrent callers serialize on the
  row lock instead of on the expression — and `deductCreditsAtomic` also gained
  the total guard the in-memory adapter already had, so the two agree.
- **The auto-create path stored `0` for an unlimited tier.** `initializeUserCredits`
  was fixed in the fourth pass but `ensureUserCredits` kept its own
  `Number.isFinite(limit) ? limit : 0`. Callers that pass an unlimited tier to
  it explicitly therefore got a zero allowance and zero credits. (Implicit
  creation from `addCreditsAtomic` is *not* one of them: it calls
  `ensureUserCredits` without a tier, which defaults to `free`.) It now goes
  through `storedMonthlyLimit`, as the paths listed in the **Seventh review
  pass** below now do as well.
- **A refused transition journal names the transition**, not just
  `field: 'journal balanceAfter'`.
- **Documentation corrected.** Two entries in this changelog still described the
  runner dropping and rebuilding an unhealthy index, and a third stated an
  operator precondition (do not rename indexes during a migration) that only
  applied while the drop existed.

### Tenth review pass

- **The reserve `insufficient` path derives `available` on the cent grid.** The
  ninth pass wrapped the `shortfall` but left its operand a float sum, so both
  numbers could still be off-grid.
- **`creditsReleased` accumulates on the cent grid** in the expiry sweep.
- **An empty `paymentRef` is normalised away** rather than skipping the
  duplicate check and then being stored, which sent a replay into the partial
  unique index.
- **The amount documentation distinguishes moving from recording**: amounts that
  move must be positive, amounts that are only recorded need only be
  representable.

### Ninth review pass

- **`balanceAfter()` sums on the cent grid.** The V2 journal total was still a
  float `balance + bonusCredits`, so a commit leaving 0.10 and 0.20 derived
  `0.30000000000000004` and the journal guard rolled back a legal transition.
- **The reserve `shortfall` is derived the same way**, so an `insufficient`
  outcome reports a number the caller can compare against.
- **`__tests__/integration/adapter-parity.test.ts` covers more.** A commit whose
  residue is two non-zero columns (the earlier one left `0 + 0.2`, which a float
  sum reaches exactly and so proved nothing), a split deduction with two
  off-grid intermediates, fractional hold-and-release, and `paymentRef` replay
  across both adapters.

### Eighth review pass

- **Derived totals are summed on the cent grid.** `addCreditsAtomic`,
  `deductCreditsAtomic` and the availability check derived their values with
  float `+`/`-`, which lands off `numeric(12, 2)` for ordinary inputs
  (`0.10 + 0.20`), so the JS guard added in the seventh pass rejected legal
  operations as `INVALID_AMOUNT`. They now use `sumAmounts` from
  `@nehorai/credits`.
- **`updateUserCredits` no longer discards an absolute field when the same call
  increments it.** `{ monthlyUsed: 5, monthlyUsedIncrement: 2 }` stored 102
  here and 7 in the in-memory adapter, because `monthly_used + 2` reads the
  stored row. The absolute now seeds the SQL expression.
- **The grace-period downgrade uses `getDefaultTier()`**, not a hard-coded
  `'free'`. An app with a different configured default downgraded users onto
  different tiers depending on the adapter.
- **Reserve idempotency compares the raw persisted `numeric`**, so a legacy
  widened row holding `9999999999.9900001` is no longer replayed as
  `9999999999.99`.
- **`__tests__/integration/adapter-parity.test.ts`** runs both adapters over the
  same inputs and asserts each against a literal expected value. All three
  divergences above reached this branch because nothing compared them directly.
- **Documentation corrected.** The README described the terminal transitions —
  lock, status CAS, journal — as though `reserveCredits` did them too; it does
  none of the three. `specs.ts` still said the runner repairs a broken index.
  The `deductCreditsAtomic` header still described the single guarded UPDATE it
  no longer is. A `paymentRef` test comment claimed a sequential call "proves
  the lock", which it does not.

### Seventh review pass

- **The unlimited-tier claim above was broader than the code.** Two writers of
  `monthly_limit` still resolved the `Infinity` sentinel their own way: the
  grace-period downgrade in this adapter read the raw `monthlyCredits` config
  field (where `0` means unlimited in the opposite direction, and the balance is
  clamped to the limit), and `CreditsService.updateTier` in `@nehorai/credits`
  wrote a literal `0`. Both now use `storedMonthlyLimit`, and an integration
  test asserts the persisted `monthly_limit` column after a service-level
  upgrade rather than trusting the value the adapter returns.
- **`paymentRef` replay is covered against a real PostgreSQL.** The duplicate
  guard now runs inside a transaction that also takes a row lock, so it has
  regressions for the sequential replay, for two distinct references, for the
  same reference racing itself (the partial unique index is the backstop; at
  most one credit lands), and for a refused overflow leaving the reference
  unconsumed so the payment can be retried.
- **A refused transition journal leaves the reservation untouched.** The
  rollback assertions now check the reservation's `status` and `completed_at`,
  not just `reserved`.

### Fifth review pass

- **A derived overflow reports the same code and field as the in-memory
  adapter.** The V2 transitions mutate with column expressions on purpose, so
  their sums are computed by PostgreSQL and a total that will not fit arrives as
  SQLSTATE 22003 — which surfaced as `DATABASE_ERROR` while the in-memory
  adapter refused the identical transition with `INVALID_AMOUNT`. `reserve` and
  `commit` now classify it, and every derived-overflow error names the column:
  `field` where the statement has exactly one derived column, `fields` where it
  has several. PostgreSQL does not name the expression that overflowed, so the
  candidate set is derived from the statement rather than read out of the error.
- **Documentation corrected.** The README still showed `report.repaired` as
  "indexes it had to rebuild" and described the runner dropping and rebuilding
  an unusable index two paragraphs before stating that it never drops anything;
  the runner's own header described the read-then-drop race as live. An older
  changelog entry claimed the attached table is compared as an OID, when the
  implementation compares the deparsed `indrelid::regclass` name and uses
  `to_regclass` only to scope the lookup to that table's schema.

### Fourth review pass

- **Stored amounts are validated in the representation PostgreSQL returned.**
  The transitions mapped `credit_reservations.amount` through `Number()` before
  checking it. On a legacy unconstrained `numeric` column, `9999999999.9900001`
  maps to a valid-looking `9999999999.99` and commit/release/expire proceeded
  with SQLSTATE 00000, while the database went on doing exact arithmetic with
  the discarded digits; `NaN` and out-of-range values mapped to `0`, misreporting
  the row. The lock now carries the driver's own string alongside the mapped
  value, and `assertValidStoredAmountRaw` checks it with exact integer
  arithmetic before any early exit or mutation.
- **The runner no longer drops indexes.** Repairing an unusable index meant
  `DROP INDEX <name>` after inspecting the catalog, and PostgreSQL re-resolves
  that name at execution — a session renaming indexes in between could redirect
  the drop onto an unrelated index, which the runner would then report as a
  successful migration. Parent-heap locks do not prevent it (measured on 14.24:
  `ALTER INDEX ... RENAME` locks the index relation). There is no OID-targeted
  drop in SQL, so the runner now stops with a `CONFIGURATION_ERROR` carrying
  `reason: 'invalid_index_needs_operator_repair'` and the exact statement to run.
  `MigrationReport.repaired` is deprecated and always `[]`; the `drop-invalid`
  step action is gone.
- **`updateUserCredits` increments no longer leak SQLSTATE 22003.** The sums are
  computed by PostgreSQL, so an overflow surfaced raw. It is now classified as
  `INVALID_AMOUNT` with the same `operation` context the in-memory adapter uses.
- **Unlimited tiers store the same number as the in-memory adapter.** This wrote
  `0` for an `Infinity` monthly limit — which reads as *no* allowance, the
  opposite of unlimited. Both adapters now go through `storedMonthlyLimit`.
- **Documentation corrected**: index identity is compared as the deparsed
  `indrelid::regclass` name, not a raw OID; lock ordering prevents deadlocks
  between these transitions but not against a caller-owned transaction holding
  the same rows in the other order; `{ concurrent: true }` takes no advisory
  lock; drizzle-kit's generated DDL does not replace the runtime catalog check.

### Third review pass

- **Nothing leaves the migration runner unclassified.** Running it against a
  database whose base tables do not exist raised the driver's raw
  `undefined_table` (SQLSTATE 42P01); a caller-owned outer transaction could
  surface a raw `deadlock_detected` (40P01) or `in_failed_sql_transaction`
  (25P02). The whole entry point is now wrapped in `classifyDatabaseError`, so a
  deploy step catching this always gets a `CreditError` it can branch on —
  `TRANSIENT_ERROR` means retry, anything else means fix the schema.
- **The read-then-drop race could not be closed, so the drop was removed.**
  Repairing an unusable index would mean reading the catalog and then issuing
  `DROP INDEX <name>`, and the name is re-resolved at execution — a concurrent
  session could rename the inspected index away and rename an unrelated one into
  the freed name in between. An earlier attempt took `ACCESS EXCLUSIVE` on the
  parent tables; measured against PostgreSQL 14.24 that does **not** block
  `ALTER INDEX ... RENAME`, which locks the index relation rather than the heap.
  The ineffective lock was removed rather than left in as false reassurance.
  Since SQL offers no OID-targeted drop, the runner stopped dropping altogether
  — see **The runner no longer drops indexes** above — which removes the race
  rather than documenting it as an operator precondition.
- **Two guarantees the docs used to imply and no longer do.** The runner
  resolves tables through `search_path` exactly as the DDL does — it migrates
  the schema the connection points at, and cannot know which schema you meant.
  And it wants a root database handle: given an open transaction, the advisory
  lock is held until the caller's outer transaction commits, and conflicting
  lock orders can still deadlock (classified, but still a failure).
- **Every public writer validates its numeric inputs, including derived ones.**
  `initializeUserCredits`, `updateUserCredits`, `updateUserTier` and `logUsage`
  passed caller numbers straight into `numeric(12,2)`, which silently rounds
  `1.005` to `1.01` and raises a bare SQLSTATE 22003 past the column range. All
  four now reject with `INVALID_AMOUNT` naming the offending field. Limits read
  out of tier configuration — `initializeUserCredits`'s `monthlyLimit`,
  `atomicMonthlyReset`'s balance — are validated too, since a misconfigured tier
  is just as capable of producing a number the column cannot hold. `Infinity`
  remains legal there as the unlimited sentinel.
- **Corrupt stored amounts are refused before the early exits.** Commit, release
  and expire validated the locked amount after returning `already_terminal` or
  `not_due`, so a corrupt row could still come back as a *successful* outcome.
  Validation now runs immediately after the row is locked, for every status.
- **Commit's journal metadata records the amount that actually moved.** Caller
  metadata is merged first and the deterministic `operationType`/`amount` last,
  so `{ metadata: { amount: 999 } }` on a commit of 10 no longer lands 999 in
  the audit trail. Release and expire already did this.

### Second review pass

- **A corrupt stored reservation amount can no longer mint credits.** Reproduced
  against PostgreSQL 14: a reservation row written with amount `-10` committed
  successfully and moved the balance 100 -> 110, `reserved` 0 -> 10 and
  `monthly_used` 0 -> -10, because `reserved >= -10` is trivially true and
  `balance - (-10)` adds. Commit, release and expire now re-validate the locked
  amount before the compare-and-set and before any balance write, raising
  `INVALID_AMOUNT` (`details.reason = 'corrupt_stored_amount'`) with the
  transaction rolled back and nothing changed.
- **The public `createReservation` validates its amount and idempotency key**,
  so such a row cannot be written through this adapter in the first place.
  `CREDITS_V2_CONSTRAINTS_SQL` adds the matching `amount > 0` database check for
  writers that bypass the library entirely.
- **The migration runner identifies an index instead of recognising its name.**
  The previous check matched substrings of `pg_get_indexdef`; the reviewer
  reproduced the blocker by creating the required *names* as healthy unique
  indexes on `(id)`, which the runner accepted. It now reads the catalog field
  by field - the table it is attached to (compared as the deparsed
  `indrelid::regclass` name, not as a raw OID; `to_regclass` is used only to
  scope the lookup to that table's schema), `indisunique`, `indisprimary`, access
  method, `indnatts` (so an `INCLUDE` column cannot slip through), `indexprs`,
  each key column via `pg_get_indexdef(oid, n, true)`, and the partial predicate
  - and refuses anything that is not an exact match with `CONFIGURATION_ERROR`.
  It never drops an index it does not recognise as its own. Regressions cover a
  unique index on `(id)`, the wrong table, reversed columns, a non-unique index,
  a missing predicate, a different predicate, an `INCLUDE` column, and a
  `lower()` expression.
- **Two migration runners can now start at once.** Previously that produced one
  success and one raw SQLSTATE 40P01 deadlock. `runCreditsV2Migration` defaults
  to running the whole migration inside one transaction that first takes a
  transaction-scoped advisory lock; `db.transaction()` pins one physical
  connection, which is what makes the lock meaningful on a pool. Six
  simultaneous runners all now return successfully, one having built the indexes
  and the rest reporting `skip`.
  - **Behaviour change:** `concurrent` now defaults to `false`, so the default
    path takes a brief write lock on the two tables instead of building with
    `CONCURRENTLY`. `{ concurrent: true }` keeps the non-blocking build and, in
    exchange, is explicitly **not** coordinated - there is no way to pin a pool
    connection outside a transaction - so only one runner may execute at a time.
    That mode refuses an invalid index rather than dropping one a concurrent
    runner might be rebuilding — as, now, does every mode.
  - A failed build inside the serialized transaction is scoped by a savepoint,
    so the duplicate-key probe still runs and the error still names the
    colliding keys.
  - `MigrationReport` gained `serialized: boolean`; `MigrationStep.action` gained
    `'lock'`.
- **`readIndexState` now reports identity**, not just health: `table`,
  `keyColumns`, `predicate`, `totalAttributes`, `accessMethod`, `matchesSpec`
  and a human-readable `mismatch`. For one of the V2 index names, `healthy` now
  means "valid, ready, live *and* the right index".
- **`assertInTransaction` no longer misreads a codeless failure.** Only a
  positively identified SQLSTATE `25P01` becomes `UNSUPPORTED_OPERATION`;
  everything else - 40001, 40P01, 25P02, connection-class codes, and an error
  carrying no SQLSTATE at all - is rethrown for the classifier. The SQLSTATE is
  read through the `cause` chain, so a driver error rewrapped by a pool is still
  identified. The supported trust boundary is stated plainly: official Drizzle
  root and transaction handles. No runtime probe can prove an arbitrary object
  is a real database; the guarantee is "a database ran this, inside a
  transaction block", not "this object is trustworthy".
- **Amount validation covers the public writers**: `addCreditsAtomic`,
  `deductCreditsAtomic`, `createReservation`, `createTransaction` and
  `createJournalEntry`. A `22003` overflow from an otherwise-valid pair of
  operands is reported as `INVALID_AMOUNT` with
  `details.reason = 'amount_out_of_range'`, not as a database fault.
- **Empty and whitespace-only idempotency keys are rejected** with
  `INVALID_IDEMPOTENCY_KEY` instead of being stored and then treated as absent
  on replay. Keys beginning `reservation:` are reserved for the transitions and
  cannot be written through the public `createJournalEntry`.
- **Deterministic journal metadata is written last**, so caller metadata cannot
  shadow the `operationType`/`amount` fields the collision check compares on.
- **The migration SQL constants are documented as non-idempotent.** The header
  previously claimed "the statements are ordered and individually idempotent",
  which stopped being true when `IF NOT EXISTS` was removed from the index
  builds. Re-running them raises `42P07` and running two copies at once can
  deadlock; reconciliation and coordination live in the runner.

**Retracted from the previous report:** the earlier pass recorded corrupt stored
amounts as an acceptable residual. That was wrong - it was the mint bug - and it
is fixed above.

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
- **A failed concurrent index build is now detected instead of skipped.**
  `CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS` leaves an invalid index
  holding the name when it fails, so the retry skipped the build and reported
  success while nothing was enforced. `IF NOT EXISTS` is gone, and the new
  `runCreditsV2Migration` reads `pg_index` (`indisvalid`, `indisready`,
  `indislive`, `indisunique`) and verifies the catalog afterwards. This entry
  originally described the runner dropping and rebuilding an unhealthy index;
  it no longer does either — it stops with a `CONFIGURATION_ERROR` naming the
  index and the `DROP INDEX` an operator should run. See **The runner no longer
  drops indexes** above. A build blocked by duplicate rows now fails
  with `CONFIGURATION_ERROR` naming the colliding keys instead of leaving a
  silent gap. (See **Second review pass** for how the identity check and the
  concurrency coordination were tightened.)
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
