# Credits V2 — idempotent, race-safe reservation boundary

Branch: `codex/credits-idempotency`

Goal: additive V2 contract on top of the existing credits packages that makes
reserve/commit/release/expire idempotent and race-safe on PostgreSQL, without
breaking the legacy API.

## Subtasks

- [x] 1. Core: typed outcomes (`ReserveOutcome` / `CommitOutcome` / `ReleaseOutcome` / `ExpireOutcome`)
- [x] 2. Core: extend `CreditErrorCode` (idempotency / transient / unsupported / invalid amount) + helpers
- [x] 3. Repository contract: optional V2 methods + inputs + capability probe
- [x] 4. Drizzle schema: nullable `idempotency_key` on reservations + journal, partial unique indexes
- [x] 5. Drizzle repository V2: single-tx, `FOR UPDATE` + status CAS, expression-based balance mutation,
      one deterministic journal per transition
- [x] 6. Drizzle: rewrite `findAndExpireReservations` on top of guarded `expireReservationV2`
- [x] 7. Migration SQL exported from `@nehorai/credits-drizzle/migrations` + README guidance
- [x] 8. InMemory: mirror V2 semantics (keyed mutex, CAS, idempotency registry, single journal)
- [x] 9. Service: `idempotencyKey` on reserve, V2-aware commit/release, no second journal, callback only on win
- [x] 10. Firestore adapter: audit only, document that it stays legacy-only (no V2 claim)
- [x] 11. Fast unit/contract tests (in-memory)
- [x] 12. Real PostgreSQL integration tests (WSL PG14, disposable DB/role, cleaned afterwards)
- [x] 13. build / typecheck / test / pack dry-run / `git diff --check`
- [x] 14. README + CHANGELOG + semver recommendation

- [x] 15. Release-blocker round (see below): 9 findings from an independent
      adversarial review, fixed with regression tests before release

## Release-blocker round

An independent adversarial review blocked commit `e01a163`. A second opinion
was obtained from `sol` at high reasoning effort, then each finding was fixed
and covered by a test that fails without the fix.

- [x] B1. **No V2 write outside a real transaction.** `withTx` no longer falls
      back to running the callback unprotected when the handle lacks
      `transaction`; it throws `UNSUPPORTED_OPERATION` first. Being *inside* a
      transaction is proven, not assumed — a `SAVEPOINT` is issued, which
      PostgreSQL rejects outside a transaction block. An already-open
      transaction is explicitly supported: the same `db.transaction()` call
      opens a savepoint, so the adapter's writes roll back even when the caller
      owns and commits the outer transaction.
      Tests: `blockers.test.ts` — non-transactional handle, fake-transaction
      handle, caller-owned-transaction rollback.
- [x] B2. **Failed concurrent index build is detected and repaired.** New
      `runCreditsV2Migration` reads `pg_index` (`indisvalid`, `indisready`,
      `indislive`, `indisunique`), drops an unhealthy index, rebuilds it, and
      verifies the catalog afterwards, failing with `CONFIGURATION_ERROR`
      naming the colliding keys if it cannot. `IF NOT EXISTS` was removed from
      the index SQL as defence in depth — which also makes the raw statements
      non-idempotent, so the runner (not the SQL) owns reconciliation.
      Superseded in part by C4/C5 below.
      Tests: `migration.test.ts` — force a duplicate-key build failure, assert
      the invalid index, repair the data, rerun, assert valid + ready + unique.
- [x] B3. **Legacy adapters refuse an idempotency key.** `idempotencyKey` on a
      repository where `supportsCreditsV2` is false throws
      `UNSUPPORTED_OPERATION` before the reserve instead of dropping the key and
      reporting `created`. The legacy fallback also stopped converting arbitrary
      infrastructure errors into `insufficient`; only a real
      `INSUFFICIENT_CREDITS` is converted. The legacy commit/release paths are
      documented as unable to promise a single winner.
- [x] B4. **`numeric(12, 2)` validation before any write**, in core so Drizzle
      and InMemory agree: non-finite, NaN, `<= 0`, over-precision and
      out-of-range raise `INVALID_AMOUNT`. Note that the obvious
      `Math.round(v * 100) === v * 100` check is wrong (`1.005 * 100` is
      `100.49999999999999`); validation rounds to cents and requires the value
      to round-trip.
- [x] B5. **`releaseCredits` compatibility.** Throws `RESERVATION_NOT_FOUND` on
      `not_found` as it did before V2. Every terminal status — released,
      expired *and* committed — is an idempotent no-op, which is the pre-V2
      contract. (The first pass had committed throw
      `RESERVATION_ALREADY_PROCESSED`; that was a breaking change to a legacy
      wrapper and was reverted in C7. `releaseCreditsDetailed` still reports
      the committed conflict.)
- [x] B6. **Journal collisions validated in full** — user, entry type, amount,
      balance-after, source, reference id, reference type and the deterministic
      metadata, with amounts compared as exact integer cents. Anything else is
      `DATABASE_ERROR` and rolls back.
      Test: pre-seed a foreign journal row on the deterministic key, attempt the
      commit, assert it fails and that no credits were deducted.
- [x] B7. **`classifyDatabaseError` actually wired** around all four public V2
      methods. `40001`, `40P01`, `55P03`, `57014`, `57Pxx` and class `08` become
      `TRANSIENT_ERROR`; other driver faults become `DATABASE_ERROR`; existing
      `CreditError`s pass through.
      Test: a real `55P03` produced with a second pool at `lock_timeout=250ms`.
- [x] B8. **Balance invariants fail closed.** `greatest(reserved - amount, 0)`
      is gone from commit, release and expire in both adapters; each requires
      `reserved >= amount` and raises `DATABASE_ERROR` on violation. Clamping is
      not defensive — it consumes the coverage of other live holds.
- [x] B9. Versions held at `1.8.0` / `0.2.0` (additive API only), docs updated,
      all gates re-run, disposable DB/role cleaned up.

Also fixed while in the area: the expiry sweep excludes reservations that fail
to expire for the rest of the run, so a corrupt row at the head of every `LIMIT`
batch cannot starve the healthy rows behind it.

## Status log

- 2026-08-27: branch created, design memo obtained via outsourcerer (`sol`, high effort).
- 2026-08-27: all 14 subtasks complete. Verification below.
- 2026-08-27: commit `e01a163` blocked by independent adversarial review;
  9 release blockers fixed with regression tests. Verification below.

## Verification

- `pnpm -r build` — success (all 10 packages)
- `pnpm -r typecheck` — clean
- `pnpm -r test` — 305 passing: credits 91, credits-drizzle 20 (real PostgreSQL
  14.24), credits-firestore 88, credits-nextjs 31, payments-sumit 75
- `git diff --check` — clean
- `npm pack --dry-run` — credits 52 files / 431 kB; credits-drizzle 29 files /
  95 kB. `dist` + README only; no tests or sources leak.

### Adversarial verification

1. **Drizzle locking removed** (dropped `FOR UPDATE`, replaced the CAS predicate
   with `true`, replaced the expression balance write with a literal) — 6 of 16
   integration tests failed: 50-concurrent-commits, two-reservations,
   commit-vs-release, commit-vs-expire, journal-failure rollback, mixed
   workload. Restored; green.
2. **Partial unique index removed** — V2 reserve throws
   `no unique or exclusion constraint matching the ON CONFLICT specification`
   and writes nothing, rather than silently double-holding. Promoted to a
   permanent test in `migration.test.ts`.
3. **In-memory mutex disabled** — initially did *not* bite: the critical
   sections contained no `await`, so `Promise.all` callers never interleaved and
   all 91 tests passed with the lock removed. Fixed by adding an injectable
   `schedulingHook` awaited at the read/write seam of each V2 transition (unset
   and free in production, a real macrotask yield in tests). With it, disabling
   the mutex fails 5 concurrency tests. Restored; green.

### Release-blocker round verification

- `pnpm -r build` — success (all 10 packages)
- `pnpm -r typecheck` — clean
- `pnpm -r test` — 349 passing: credits 113, credits-drizzle 42 (real
  PostgreSQL 14, disposable role/db), credits-firestore 88, credits-nextjs 31,
  payments-sumit 75
- `git diff --check` — clean; all new files are LF
- `npm pack --dry-run` — credits 52 files / 472.8 kB; credits-drizzle 32 files /
  127.9 kB. `dist` + docs only.

Mutation testing of the new guards (every mutation reverted, suites re-verified
green afterwards):

1. Drizzle batch — `withTx` fallthrough restored, `reservedCoversHold` replaced
   with `true`, the `greatest()` floor restored in commit and `releaseHold`,
   journal mismatch reduced to `user_id` only → **8 of 37 failed**.
2. Migration runner — the `exists && !healthy` repair branch stubbed to
   `if (false)` → the failed-build recovery test failed.
3. Core batch — legacy idempotency-key guard removed, "any error becomes
   insufficient" restored, the `releaseCredits` not-found throw removed, the
   in-memory invariant short-circuited, `isValidCreditAmount` weakened to
   `Number.isFinite(value) && value > 0` → **11 of 111 failed**.

Honest negative result: restoring `IF NOT EXISTS` on the index SQL **on its own
failed no test**. The runner's catalog check is what actually closes B2; the
`IF NOT EXISTS` removal is defence in depth, not the fix.

### Second adversarial round (on the blocker fixes themselves)

The blocker fixes were then re-reviewed adversarially, one claim at a time, by
an external model asked to refute rather than confirm. Five real defects in the
new guards came back, all fixed here:

- **The transaction probe could be satisfied by a stub.** A `transaction` that
  opens one for real but an `execute` that resolves with nothing passed a
  statement-only savepoint check. The probe now requires the server to echo a
  token back.
- **Every probe failure was reported as "not in a transaction".** 25P02, from
  an already-aborted transaction, was blamed on the caller's handle. Only 25P01
  (or an error with no SQLSTATE) is read that way now; anything else is
  rethrown for the classifier.
- **The migration runner trusted the index name.** Index names are unique per
  schema across all relations, so a healthy unique index on the *wrong table*
  made the runner skip the build and pass its own final verification, leaving
  the target table unconstrained. It now compares `indrelid` and the index
  definition and refuses with `CONFIGURATION_ERROR`.
- **The journal metadata comparison was one-sided.** `'amount' in expectedMeta`
  meant a stored row recording a hold size the transition does not carry was
  accepted — and a commit's metadata carries no amount, so this was reachable.
  Presence is now compared in both directions before value.
- **The sweep still stopped on an all-poison batch.** Excluding failed rows was
  not enough: with `progressed === 0` the loop broke before ever querying the
  healthy rows behind them, which is the starvation the exclusion list exists
  to prevent. Growing the skip set now counts as progress.

Also changed: the unsupported-idempotency-key refusal now precedes amount
validation, so the capability error wins when both apply.

Each of the six changes was mutation-tested individually: reverting any one of
them fails exactly the test written for it (5 in credits-drizzle, 1 in credits).

Two findings were considered and deliberately not acted on:

- A handle that faithfully impersonates PostgreSQL — accepting the savepoint and
  echoing the token — still passes. No probe can distinguish that from a real
  server; the README now states the guarantee as "a database ran this, inside a
  transaction block" rather than claiming the handle is trustworthy.
- An `input` object whose `userId` getter throws was offered as a way to escape
  the error classifier. That is not a reachable failure mode for a plain input
  object, and guarding it would add noise for no coverage.

## Second adversarial review (blockers C1-C10)

A second independent review reproduced ten blockers the first report missed or
left open. All ten are closed on this branch.

- [x] C1. **Corrupt persisted amounts cannot mint credits.** Every V2 transition
      re-validates the amount it locked, before the CAS and before any write, in
      both adapters. Commit, release and expire all refuse with `INVALID_AMOUNT`
      (`details.reason = 'corrupt_stored_amount'`) and change nothing. The
      public `createReservation` validates on the way in, on both adapters.
      Operator path for a stuck row: correct the `amount` (or reconcile
      `reserved` from the remaining valid holds), then release. Applying
      `CREDITS_V2_CONSTRAINTS_SQL` prevents such a row being written at all.
      Tests: `corrupt-rows.test.ts` (PG14, negative/zero/NaN × commit/release/
      expire, plus the exact 100 → 110 reproduction), `corrupt-state.test.ts`
      (in-memory, six corrupt values × three transitions).
- [x] C2. **`assertInTransaction` classifies honestly.** Only a positively
      identified `25P01` becomes `UNSUPPORTED_OPERATION`; the SQLSTATE is read
      through the whole `cause` chain. Everything else is rethrown.
      Tests: `transaction-probe.test.ts` (40001, 40P01, 25P02, 08006, 57014,
      42P01, a codeless error, and 25P01 nested on `cause`), plus a real
      root-database 25P01 in `blockers.test.ts`.
- [x] C3. **In-memory journal parity.** The public `createJournalEntry`
      registers its key and rejects duplicates; the collision preflight runs
      before any mutation, so a refused transition leaves the ledger untouched;
      and the `reservation:` key namespace is reserved from public writes on
      both adapters, which closes the pre-seed-and-adopt hole rather than only
      detecting it.
- [x] C4. **Migration index identity is read from the catalog**, field by field,
      not from a substring of `pg_get_indexdef`. Eight impostor indexes are
      regression-tested and none is ever dropped.
- [x] C5. **Concurrent migration runners are safe.** The default path is one
      transaction under `pg_advisory_xact_lock`. Six simultaneous runners all
      succeed. `{ concurrent: true }` keeps the non-blocking build and is
      documented as operator-serialized; it never drops an index.
- [x] C6. **Amount validation matches the claim.** Applied at every public
      writer in the service and both repositories. `22003` is reported as
      `INVALID_AMOUNT`/`amount_out_of_range`.
- [x] C7. **Legacy `releaseCredits` no-op restored** for every terminal status.
- [x] C8. **Idempotency keys must be non-empty**, in both adapters, with the new
      `INVALID_IDEMPOTENCY_KEY` code. Not trimmed — trimming would alias two
      distinct keys onto one hold.
- [x] C9. **Deterministic journal metadata is written last** and cannot be
      shadowed by caller metadata.
- [x] C10. **Docs corrected.** The "individually idempotent" claim is gone from
      the migration module, the README and the changelog; the concurrency
      contract of each runner mode is stated explicitly; and the first report's
      "corrupt stored amounts are an acceptable residual" decision is retracted
      above.

### Third pass (D1-D5)

A third adversarial review, run against the corrected diff, found five more.
All five are fixed.

- [x] D1. **The migration runner leaked raw SQLSTATEs.** Running it against a
      database with no base tables raised the driver's raw 42P01; a caller-owned
      outer transaction could surface raw 40P01 or 25P02. Blocker 5 asked for
      "the documented typed retryable outcome, never raw deadlock", and the
      classifier only covered the index-build step. The whole entry point is now
      wrapped, so a `CreditError` is the only thing that can escape.
- [x] D2. **Read-then-drop was a race.** The runner reads the catalog, decides
      an index is unusable, and drops it *by name*. Index names are unique per
      schema, so another session could rename the target away and rename an
      unrelated healthy index into the freed name in between. The serialized
      path now takes an explicit `ACCESS EXCLUSIVE` lock on both tables before
      the catalog read and holds it to commit; renaming an index requires a lock
      on its table, so the window is closed. Reported as a `lock` step.
- [x] D3. **Two guarantees the docs implied and the code does not make.** The
      runner resolves tables through `search_path`, exactly as the DDL does — it
      migrates whichever schema the connection points at and cannot verify that
      it is the one you meant. And it wants a root handle: given an open
      transaction, the advisory lock is held until the caller's outer
      transaction commits, and conflicting lock orders can still deadlock.
      Both are now stated in the README and the module header rather than
      implied away.
- [x] D4. **Public writers bypassed amount validation.** Blocker 6 said "every
      public operation that writes a numeric(12,2) amount"; four were missed on
      the SQL side and four on the in-memory side. `initializeUserCredits`,
      `updateUserCredits`, `updateUserTier` and `logUsage` now validate on both
      adapters, with identical field names, via `assertRepresentableFields`.
- [x] D5. **Commit let caller metadata name a fake amount.** Blocker 9 was fixed
      for `operationType` but not for `amount`: `{ metadata: { amount: 999 } }`
      on a commit of 10 landed 999 in the journal. Both adapters now merge
      caller metadata first and the deterministic fields last.

### Fourth pass (E1-E6)

A fourth adversarial review of the corrected diff found six more. All are fixed.
One of them corrected a mistake made in the third pass.

- [x] E1. **Corrupt amounts were validated after the early exits.** Commit,
      release and expire checked the locked amount only once past the
      `already_terminal` / `not_due` returns — both of which are *success*
      outcomes. A reservation stored with `NaN` and status `committed` came back
      as "already done, all fine". Validation now runs immediately after the row
      is locked, for every status, on both adapters.
- [x] E2. **The third pass's table lock did not do what it claimed, and is
      gone.** D2 added `LOCK TABLE ... IN ACCESS EXCLUSIVE MODE` on the reasoning
      that renaming an index requires a lock on its parent heap. Measured against
      the PostgreSQL 14.24 instance used for this work, it does not:
      `ALTER INDEX ... RENAME` takes its lock on the index relation and succeeds
      while the heap is held `ACCESS EXCLUSIVE`. The lock was removed rather than
      left in as false reassurance, the README/CHANGELOG/module-header claims
      were retracted, and the real precondition — do not rename indexes into or
      out of the V2 names during a migration — is stated instead. An integration
      test pins the measured behaviour so the docs can be revisited if a future
      PostgreSQL changes it.
- [x] E3. **Tier-derived numeric writes were unvalidated.** Blocker 6 covered
      caller-supplied amounts but not values read out of tier configuration:
      `initializeUserCredits`'s `monthlyLimit`, `atomicMonthlyReset`'s balance,
      and the downgrade path in `checkAndHandleSubscriptionExpiry`. A tier
      configured with `monthlyCredits: 1.005` was stored as `1.01` by PostgreSQL
      and verbatim in memory. `assertRepresentableTierAmount` now checks all of
      them, permitting `Infinity` as the unlimited sentinel.
- [x] E4. **Legacy `releaseCredits` could still throw on a terminal hold.**
      `releaseThroughRepository` called `releaseReservationAtomic` after
      observing a terminal status; an adapter that rejects processed
      reservations made the error propagate past the service wrapper, so the
      specified silent no-op was not silent. The call is kept for adapters that
      reconcile there, but a refusal is swallowed — the conflict is what
      `already_terminal` reports and `releaseCreditsDetailed` surfaces.
- [x] E5. **The legacy commit path let caller metadata name a fake amount.**
      Blocker 9 was fixed on the V2 transitions and the legacy release, but not
      the legacy commit. It now merges caller metadata first and the
      deterministic `operationType`/`amount` last, like the others.
- [x] E6. **Six further documentation overstatements corrected.** The runner
      does not drop an index for failing `indisunique` (that is a wrong-identity
      refusal); the transaction probe does not treat a codeless error as "no
      transaction" (it rethrows it); "every public writer" now names the derived
      values it covers; "every transition" now says it applies before the early
      exits; and the retracted lock claim is removed from three places.

### Fifth pass (F1-F4)

- [x] F1. **Lossy persisted numeric validation.** SQL transitions validated the
      amount *after* mapping it through `Number()`. On an unconstrained `numeric`
      column, `9999999999.9900001` maps to a valid `9999999999.99` and the
      transition proceeded; `NaN` and out-of-range values mapped to `0`.
      `lockReservation` now carries the driver's raw string, and
      `assertValidStoredAmountRaw` validates it with exact integer arithmetic
      before every terminal, not-due and mutating exit. PostgreSQL regressions
      cover commit, release and expire against a widened column.
- [x] F2. **Read-then-drop repair removed.** No mode drops an index any more.
      The decisive regression records every statement the runner sends while it
      faces an index it would once have repaired, and asserts none is a drop.
      The rename-swap test is kept but is *not* evidence for the fix: the
      wrong-identity guard already refuses that scenario, so it passes against
      the old dropping implementation too, and it says so.
- [x] F3. **Derived numeric writes.** Projected and validated before mutation in
      the in-memory adapter (no rollback available there); classified
      consistently in the SQL adapter. The `Infinity` monthly limit is resolved
      by one shared `storedMonthlyLimit` contract rather than diverging per
      adapter.
- [x] F4. **Documentation.** Six overclaims corrected — see the changelogs.

**One thing worth flagging about F3.** The derived `reserved` overflow on
`reserveCreditsV2` is not reachable through the public API: the insufficiency
check refuses first in every state where the sum could overflow. The guard is
defence-in-depth for a store mutated out of band, and the regression has to seed
`balance`, `bonusCredits` and `reserved` each individually legal to reach it at
all. It is not a live exploit path.

### Sixth pass (re-review of F1-F4)

The bounded re-review confirmed F1 and accepted the F2/F3 implementations, but
blocked on three things. All are now closed.

- [x] **The no-drop regression was vacuous.** Its regex literal contained two
      *backspace characters* around `DROP` rather than `\b` word-boundary
      escapes — a shell-heredoc escape that survived into the source — so it
      matched nothing and the test passed against a runner that dropped the
      index. Replaced with a plain substring match, and verified by re-applying
      the drop: the test now fails, and passes again once the drop is removed.
- [x] **The journal's derived total was unvalidated in the in-memory adapter.**
      `balanceAfter` is a sum, not one of the balance columns, so per-column
      validation missed it; with balance and bonus each at the ceiling the
      recorded total was about twice the column's range. Validated in
      `planTransitionJournal`, the shared preflight, before any mutation. Four
      regressions (commit, release, expire, and untouched-ledger) all fail when
      the check is removed.
- [x] **SQL derived overflow carried no field, and the V2 paths did not classify
      it at all.** A commit overflowing `monthlyUsed` surfaced as
      `DATABASE_ERROR` while the in-memory adapter raised `INVALID_AMOUNT`.
      `reserve` and `commit` now classify SQLSTATE 22003 and name the derived
      column. PostgreSQL does not report which expression overflowed, so the
      candidate columns come from the statement: `field` when there is exactly
      one, `fields` when there are several. Two PostgreSQL regressions, both
      verified to fail with the classification removed.
- [x] **Documentation.** README `report.repaired` example, the drop/rebuild
      paragraph that contradicted the never-drops paragraph, the runner header
      describing the race as live, the stale `ApplyOptions` comment, and the
      changelog's table-OID claim.

**Method note.** Every regression added in this pass was mutation-tested: the
fix was reverted and the test observed to fail. That is how the vacuous regex
above was caught, and it is the only reason to believe the rest are load-bearing.

### Seventh pass (re-review of F3/F4)

F1 and F2 were approved. The remaining six defects are closed; every regression
below was mutation-tested (fix reverted, test observed to fail).

- [x] **`updateUserCredits` partially mutated.** Absolute fields were assigned
      to the live record before the increment-derived results were validated.
      Now the whole record is projected onto a candidate — absolutes, then
      increments on top of them, then tier and timestamps — validated, and
      swapped in. A regression snapshots the entire record and asserts deep
      equality after a refused call.
- [x] **`addCreditsAtomic` misattributed overflow.** It reported
      `field: 'bonusCredits'` for a failure in the derived *total*. Now locks
      the balance row, computes `previousBalance` / `bonusCredits` /
      `newBalance`, and validates each under its own name before writing.
- [x] **`deductCreditsAtomic` mutated before checking its totals.** Same locked
      boundary; `previousBalance` and `newBalance` are validated before the row
      moves, matching the in-memory adapter field for field.
- [x] **Journal `balanceAfter` errors name the transition** in both adapters —
      `commitReservation`, `releaseReservation`, `expireReservation` — threaded
      through `planTransitionJournal` and `writeTransitionJournal`.
- [x] **Unlimited-tier contract tests assert the canonical value.** The old test
      used the `free` tier, which never produces the sentinel, and compared the
      adapter against itself. Now it uses the `unlimited` tier and asserts the
      literal `9999999999.99` on both adapters and in the column. This exposed a
      live bug: `ensureUserCredits` kept its own `isFinite ? x : 0`, so an
      implicitly-created unlimited user got a zero allowance.
- [x] **Documentation.** Two drizzle changelog entries still described the
      runner dropping and rebuilding; one stated a rename-free operator window
      that only applied while the drop existed; the credits README and changelog
      claimed complete derived validation while `updateUserCredits` was open.

**Method note.** Six mutations were applied and each was caught: memory
`updateUserCredits` assigning before validating (3 failures), the journal
`operation` context removed in each adapter (3 each), the SQL `addCredits` and
`deductCredits` derived guards removed (2 and 1), and `ensureUserCredits`
reverted to `isFinite ? x : 0` (1).

### Eighth pass (re-review of the seventh)

The seventh review confirmed items 1-4 fixed and F1/F2 intact, and blocked on
two things: a third writer of `monthlyLimit` that still stored zero, and
changelogs whose unlimited-tier claims were broader than the code. Both are
closed here, along with the regression-quality gaps the reviewer named.

- [x] **`CreditsService.updateTier` stored `0` for an unlimited tier**, under a
      "0 means unlimited" convention no read path in the library implements, so
      an upgraded user was persisted with a zero allowance. It now uses
      `storedMonthlyLimit`.
- [x] **The grace-period downgrade read raw `monthlyCredits`** in both adapters,
      where `0` means unlimited in the opposite direction — and the downgraded
      balance is clamped to the limit, so a user landing on an unlimited default
      tier was zeroed. Both now resolve through `getConfigMonthlyLimit` and
      `storedMonthlyLimit`.
- [x] **`__tests__/unit/unlimited-tier-contract.test.ts`** (6 tests) asserts the
      literal canonical value for the mapping, `initializeUserCredits`, the
      service upgrade, a finite upgrade, and the downgrade onto an unlimited
      default tier. A Drizzle test asserts the persisted `monthly_limit` column
      after a service-level upgrade, so the SQL side is pinned at the column,
      not at the value the adapter hands back.
- [x] **`paymentRef` replay has explicit regressions** against PostgreSQL: the
      sequential replay credits once, two distinct references both credit and
      the second sees the first (proving the lock), the same reference racing
      itself lands at most one credit, and a refused overflow leaves the
      reference unconsumed so the payment can be retried.
- [x] **Unchanged-state assertions strengthened.** The refused-journal tests in
      both adapters now assert the reservation's `status` and `completedAt`, not
      only `reserved`, so a rollback that terminated the row while leaving the
      credits held would be caught.
- [x] **The field-only test is labelled honestly.** `input-validation.test.ts`
      names a test "names the derived field that refused"; it would pass against
      the old partial-mutation bug, and a comment now says so and points at the
      test that actually carries the atomicity claim.
- [x] **Changelogs made truthful.** Both now scope the fourth-pass claim to
      `initializeUserCredits` and name the paths fixed here. The Drizzle entry's
      claim that `addCredits` could implicitly create an unlimited-tier user was
      wrong — `lockUserCredits` calls `ensureUserCredits` without a tier, which
      defaults to `free` — and is corrected. A duplicated `### Release-blocker
      fixes` heading in the credits changelog was removed.

**Method note.** Four mutations, all caught: `updateTier` reverted to `0` (1
failure), the downgrade reverted to raw `monthlyCredits` (1), the `paymentRef`
duplicate guard disabled (1), and the two new hold-state assertions flipped to
prove they read live values (3 and 3). The `updateTier` fix was also confirmed
by an accidental control: the Drizzle suite consumes the built
`@nehorai/credits`, and against the pre-fix `dist` the new column assertion
failed with `0`.

### Ninth pass (re-review of the eighth)

The eighth review returned BLOCK with four defects, all confirmed by reading the
code and reproducing the arithmetic. Every fix below was mutation-tested.

- [x] **Float arithmetic rejected legal amounts.** Derived totals were computed
      with `+`/`-`, then validated against the cent grid: `0.1 + 0.2` is
      `0.30000000000000004`, so adding 0.20 to a 0.10 balance failed with
      `INVALID_AMOUNT`. This was the most serious defect in the branch — the
      seventh pass's validation made a latent representation issue into a live
      one. `sumAmounts` in `core/amount.ts` sums whole cents and is exact in
      range; both adapters use it for every derived value.
- [x] **The SQL downgrade hard-coded `'free'`** while the in-memory adapter used
      `getDefaultTier()`.
- [x] **Reserve replay compared the mapped `Number`**, so a widened legacy row
      holding `9999999999.9900001` replayed as `9999999999.99`. It now compares
      the raw `numeric` via `sameAmount`.
- [x] **Absolute + increment in one call diverged** between the adapters (7 vs
      102). The SQL expression now seeds from the absolute when one is given.
- [x] **Cross-adapter parity is now tested directly.** All three divergences
      existed because no test ran the same input through both adapters.
      `credits-drizzle/__tests__/integration/adapter-parity.test.ts` does, and
      compares each side to a literal expected value rather than to the other.
- [x] **Six documentation and comment overclaims corrected**, including the
      README's V2-boundary description (which described the three terminal
      transitions as though reserve did them too), `specs.ts` still claiming the
      runner repairs indexes, the stale `deductCreditsAtomic` header, and a test
      comment claiming a sequential call proved a row lock.

**Method note.** Six mutations, all caught: `sumAmounts` reverted to float
addition (7 failures), the SQL downgrade reverted to `'free'` (1), `incrementFrom`
reverted to reading the stored column (1), the SQL derived sums reverted to
floats (2), and the reserve replay comparison reverted to the mapped `Number`
(1).

### Tenth pass (re-review of the ninth)

The ninth review returned BLOCK with nine findings. All nine were reproduced and
fixed; two additional defects surfaced while writing the regressions.

- [x] **The eighth pass's `sumAmounts` sweep was incomplete.** It converted the
      adapters' add/deduct/update paths and missed the V2 journal total in the
      SQL adapter, the in-memory reservation arithmetic, the split deduction,
      the shared `availableCredits` helper, every `shortfall`, and the whole
      service layer. A grep-driven sweep of every `a + b` / `a - b` over a money
      field now covers all of them.
- [x] **`sumAmounts` no longer claims to guarantee downstream failure.** Two
      off-grid inputs can cancel. Stored amounts are validated as inputs.
- [x] **Service journal entries record `balance + bonusCredits`**, matching every
      other writer, in the downgrade, the monthly reset, and the two legacy
      entries in `repository/flow.ts`.
- [x] **The downgrade description names the configured tier**, not "free".
- [x] **The in-memory `addCreditsAtomic` honours `paymentRef`.**
- [x] **Found while testing: the in-memory adapter leaked live records.**
      `getUserCredits` and the reset/expiry results returned the stored object,
      so a caller's earlier snapshot mutated under them. This silently
      suppressed the monthly reset's journal entry — the service's
      `balanceChange` compared an object against itself and got 0. Every read
      now returns a copy.
- [x] **Found while mutation-testing: two new parity assertions were vacuous.**
      Both commit tests left a residue of `0 + 0.2`, which a float sum reaches
      exactly, so neither could expose a raw `balance + bonusCredits`. They now
      leave `0.1 + 0.2`.

**Method note.** Eight mutations, all caught after the two vacuous assertions
were fixed. One caveat worth recording: the SQL package's parity suite imports
`@nehorai/credits` from `dist`, so mutating in-memory *source* proves nothing
until `pnpm build` runs. A mutation that "survives" there is a build artefact,
not a passing test — the first run of mutation N was exactly that.

### Eleventh pass (re-review of the tenth)

The tenth review returned BLOCK with seven findings; all seven were confirmed
and fixed.

- [x] **Three derived-money sites remained**: `getTotalCredits`, the Drizzle
      reserve `available` (whose `shortfall` had been wrapped while its operand
      had not), and `creditsReleased` in both expiry sweeps.
- [x] **Copy-on-read was only applied to user records.** Reservations,
      transactions, journal entries, usage logs and the `getAll*` helpers all
      still handed out live objects, and `metadata` was stored by reference in
      both directions. `repository/memory/snapshot.ts` now holds the shared
      helpers and every boundary uses them.
- [x] **An empty `paymentRef` diverged between adapters** — falsy for the SQL
      duplicate check but still stored, so a replay hit the unique index. Both
      adapters now normalise it to "no reference".
- [x] **The monthly-reset cent-grid regression was vacuous.** It reset 0.3 up to
      10, and `10 - 0.3` is exactly 9.7. It now configures a 0.3 target against
      a 0.1 balance, where the delta is `0.19999999999999998`.
- [x] **Both READMEs overclaimed** that zero and negative amounts are rejected
      before every write. The transaction and journal writers accept them by
      design; the two rules — movable versus recordable — are now stated.
- [x] **The ninth-pass changelog entries were rescoped** so they describe what
      that pass actually did rather than what this one finished.

**Method note.** The vacuous reset regression is the second assertion this round
that passed for the wrong reason, both caught by a reviewer rather than by my own
mutation run — the mutation only proves the test is sensitive to *something*, and
both of these were sensitive to the operation happening at all, not to the
arithmetic. Choosing operands whose float result actually differs is the part
that has to be checked by hand.

### Twelfth pass (self-audit against the tenth review's questions)

Rather than wait for the next reviewer to find the remainder, I re-ran the tenth
review's two sweep questions myself.

- [x] **Arithmetic sweep: clean.** No raw `+`/`-` remains on a money-valued
      field whose result is stored, validated or returned, in either package,
      the service layer, the SDK or the error helpers.
- [x] **Copy-on-read sweep: one site left**, `logUsage`, now fixed. The only
      remaining live-record return is `requireUser` in `memory/v2.ts`, which is
      module-private and deliberately live — the transitions write through it —
      and is now commented as such.
- [x] **DRY: the duplicate snapshot helper is gone.** `memory/v2.ts` had its own
      `snapshot()`; both now use `copyRecord`.

### Known divergences and residuals, recorded rather than fixed

- **`{ concurrent: true }` can refuse while another runner is mid-build.**
  A `CREATE INDEX CONCURRENTLY` in progress is briefly `indisvalid = false`, and
  a second runner reading it reports `CONFIGURATION_ERROR` — typed, but not
  retryable. This mode already documents that the operator must ensure only one
  runner executes at a time; the serialized default has no such caveat.
- **Several files are over the 150-line guideline in `CLAUDE.md`**:
  `migrations/runner.ts` (347), `repository/v2/shared.ts` (377) and
  `repository/index.ts` (760). Splitting them now would churn the files every
  reviewer in this round worked from, so this is recorded for a follow-up
  refactor rather than done during a release-blocker pass.

### Raised by the reviewer and deliberately not done

- **Recomputing `reserved` from the remaining valid holds** when quarantining a
  corrupt reservation. The reviewer argued refusing release/expire converts
  corruption into an account-level denial of service. That is true, and it is
  the specified behaviour: silently subtracting an untrusted amount is the
  larger risk. Automatic reconciliation would need an audit trail and an
  operator recovery procedure, which is a feature, not a blocker fix.
- **Per-entry-type sign invariants** on journal and transaction records (a
  debit must not be negative, etc.). Worth doing; not one of the ten.
- **Length limits on public idempotency keys.** Worth doing; not one of the ten.
- **A `numeric` CHECK constraint rejecting `NaN`.** `CREDITS_V2_CONSTRAINTS_SQL`
  adds `amount > 0`, which excludes `NaN` for reservations. The journal and
  transaction tables have no equivalent, and application validation cannot
  protect against direct SQL.

## Not done / out of scope

- Not published to npm, not pushed. Branch `codex/credits-idempotency` only.
- `@nehorai/credits-firestore` is legacy-only by decision. It implements no V2
  method and carries no idempotency or single-winner guarantee. Its 88 existing
  tests still pass; nothing about it was changed or claimed.
- `@nehorai/credits-nextjs` unchanged. Its `withCredits` options are
  per-action-definition, not per-request, so a static `idempotencyKey` there
  would dedupe every request forever. Per-request keys require calling
  `CreditsService.reserveCredits` directly.
- ~~The legacy (non-V2) commit path takes the reservation's stored amount on
  trust.~~ **Retracted.** This was recorded as an acceptable residual in the
  first pass. It was not: it was the mint bug, reproduced against PostgreSQL 14
  (amount `-10` committed and moved balance 100 → 110). See C1 below. The
  "wedging it permanently" objection was answered by making the refusal apply to
  release and expire as well, so a corrupt row stops moving entirely and waits
  for an operator rather than being handed back on manufactured coverage.
- Deliberately not implemented from the second opinion, and worth revisiting:
  treating a terminal status alone as an idempotent replay (without the journal
  key), reordering the reconciliation path behind an advisory lock, and adding
  an `UNKNOWN_OUTCOME` for a commit whose connection dropped mid-COMMIT. Each is
  a semantic change to the public contract rather than a blocker fix, so none
  belongs in this release.

## Third adversarial round — P0-A/P0-B/P1-A-D (2026-08-28)

A follow-up review packet named two P0 items that move money and four P1 items
that make the boundary honest about its own schema and contracts. All six are
closed, in the packet's order, with the regressions each one asked for.

### P0-A — a reservation row is not a hold

`createReservation` writes a row and never touches `reserved`. With an
`idempotencyKey` on that row, `reserveCreditsV2` found it, reported `replayed`,
and the caller's commit then passed its `reserved >= amount` guard on coverage
belonging to a *different*, genuine hold. Two holds, one payment.

**The single invariant chosen:** a row is a reservation only if the same atomic
operation that wrote it also increased `reserved` by its amount. It is persisted
as `hold_placed_at` (`PortableReservation.holdPlacedAt`), written by
`reserveCreditsV2` inside the transaction that raises `reserved` and by nothing
else — so the fact and the hold commit together or not at all.

Both halves of the rule are enforced:

- `assertUnkeyedDirectReservation` — `createReservation` refuses any
  `idempotencyKey` with `UNSUPPORTED_OPERATION` (`core/reservation-integrity.ts`).
- `assertHoldPlaced` — checked before a replay is adopted and before every
  transition, in both adapters (`memory/v2.ts`,
  `repository/v2/{reserve,shared}.ts`).

The migration adds `hold_placed_at` with a one-shot backfill from `created_at`,
inside the same `IF NOT EXISTS` branch as the `ADD COLUMN`. Rows that predate
the column keep working; a NULL that appears *after* the column exists is never
blessed by a re-run.

Regressions: `credits/__tests__/unit/unbacked-reservation.test.ts` and
`credits-drizzle/__tests__/integration/unbacked-reservation.test.ts`. Both plant
two keyed rows plus one genuine hold and assert isolation, full coverage and
unchanged state.

### P0-B — `paymentRef` is a global, semantic idempotency boundary

Three defects, one per axis. Scope: memory searched only the crediting user's
transactions while SQL enforced a global unique index. Payload: presence was
enough, so a redelivery carrying a different amount credited the original.
Blankness: an empty string was falsy for the check and truthy for the write.

`addCreditsV2` now returns `created | replayed | conflict` in both adapters
(`core/outcomes.ts`, `core/payment-ref.ts`). The reference is normalised once
(`normalizePaymentRef`), the payload is compared on the canonical fields
(`describePaymentMismatch`: user, raw stored amount on the cent grid, type,
source, referenceType), and a conflict writes nothing. `addCreditsAtomic` keeps
its `void` signature and throws `IDEMPOTENCY_CONFLICT` rather than returning
silently, which was indistinguishable from "credited".

In SQL the arbiter is the partial unique index, not a read-then-write: the
transaction row is inserted with `ON CONFLICT (payment_ref) DO NOTHING`
**before** the balance moves. The conflict clause is attached only when a
reference is present, so an unreferenced credit does not depend on the index
while a referenced one does — and a missing or drifted index raises SQLSTATE
42P10 instead of silently duplicating.

Regressions: `credits/__tests__/unit/payment-ref.test.ts` and
`credits-drizzle/__tests__/integration/payment-ref.test.ts` (8-way same-reference
race, 4-way cross-user race, amount/user/source mismatch, blank and padded
references, unchanged state on conflict, and the dropped-index fail-closed case).

### P1-A — migration identity, not names

`V2IndexSpec` now carries its key columns and predicate, so the catalog reader
compares against the spec rather than against a hard-coded
`(user_id, idempotency_key)`; `credit_plugin_transactions_payment_ref_unique` is
a verified V2 object because `addCreditsV2` depends on it. New
`migrations/columns.ts` reads column identity (`format_type`, `attnotnull`,
`attgenerated`, `attidentity`, `pg_attrdef`) and CHECK definitions
(`pg_get_constraintdef`), and `migrations/verify.ts` refuses the run on any
mismatch — before any index is built. A `DEFAULT now()` on `hold_placed_at` is
refused specifically because it would forge the hold-origin fact.

Regression: `credits-drizzle/__tests__/integration/migration-identity.test.ts`
(narrowed type, NOT NULL, DEFAULT, generated column, two constraint drifts, the
backfill and its one-shot property, plus a non-vacuous healthy-schema check).
The statement spy in `migration-safety.test.ts` now matches DROP as a command
rather than as a substring, and proves the detector still catches a real one.

### P1-B — one unlimited contract

`monthlyResetBalance(tier)` is the single definition: a metered tier resets to
exactly its configured limit, an unlimited tier to *at least*
`UNLIMITED_BALANCE_SENTINEL`. The SQL reset used to leave an unlimited balance
untouched, so an account degraded to `0` stayed there through every reset while
memory recovered; it now writes `greatest(balance, sentinel)`.

Regression: `credits-drizzle/__tests__/integration/monthly-reset-parity.test.ts`
asserts literal values in both adapters (a degraded `0` recovers to `999999`, a
topped-up balance is not cut down, a metered tier lands on exactly `500`).

### P1-C — a corrupt status is not a status

`terminalStatusOf` validates instead of casting, and
`assertKnownReservationStatus` runs ahead of every early exit — including
`already_terminal` and `not_due`, both of which are success outcomes. An unknown
status quarantines the row with `CORRUPT_RESERVATION_STATUS` naming the user,
the row, the transition and the allowed set, and changes nothing.

Regressions: `credits/__tests__/unit/corrupt-status.test.ts` and
`credits-drizzle/__tests__/integration/corrupt-status.test.ts`.

### P1-D — the package boundary

`pnpm pack` rewrites `workspace:^` to `^1.8.0`; verified on the packed manifest
rather than on the source one, along with the tarball containing only `dist`
plus metadata and every documented entry point resolving to a shipped file.
Regression: `credits-drizzle/__tests__/unit/package-manifest.test.ts`. Publish
order (core, then drizzle) follows from the concrete range and is unchanged.
**Nothing was published.**

### Verification (2026-08-28)

- `pnpm -r build` — success; `pnpm -r typecheck` — clean
- `pnpm -r test` — 691 passing: credits 304, credits-drizzle 193 (real
  PostgreSQL 14.24), credits-firestore 88, credits-nextjs 31, payments-sumit 75
- `git diff --check` clean; no CRLF and no control characters introduced
- `pnpm pack` for both packages — manifests and contents asserted, not published

Mutation checks (each reverted immediately):

| Mutation | Result |
| --- | --- |
| memory replay `assertHoldPlaced` removed | 1 failure |
| drizzle replay `assertHoldPlaced` removed | 1 failure |
| `describePaymentMismatch` userId check disabled | 3 failures |
| memory `paymentRef` lookup scoped back to one user | 3 failures |
| balance moved before the `ON CONFLICT` arbiter decides | 7 failures |
| `ON CONFLICT DO NOTHING` removed from the credit insert | 9 failures |
| unlimited reset reverted to "leave the balance alone" | 2 failures |
| `assertKnownReservationStatus` made a no-op | 18 failures |
| column type check disabled | 2 failures |
| column DEFAULT check disabled | 1 failure |

### Residuals from this round

- `repository/index.ts` (734 lines) and `repository/v2/shared.ts` (377) are
  still over the 150-line guideline. `migrations/runner.ts` was split (347 to
  241, plus `errors.ts`, `verify.ts` and `columns.ts`), and the new credit path
  went into its own `repository/add-credits.ts` rather than growing the
  repository class further.
- `@nehorai/credits-firestore` stores `paymentRef` and still performs no
  deduplication. It implements no V2 method and claims no idempotency; it is
  unchanged and nothing is claimed for it here.
- The legacy `addCreditsAtomic` fallback in `addCreditsThroughRepository` (for a
  repository that implements no `addCreditsV2`) carries no deduplication
  guarantee, and says so in its doc comment.

## Fourth adversarial round — external audit F1-F10 (2026-08-28)

A fully external audit (Codex, run through the codex-rescue agent against
commit `cf8aae6`) returned **DO-NOT-SHIP** with ten findings. Each was
independently verified here before acting; seven are fixed, one was
documentation, two are adjudicated residual risks recorded below.

### Fixed

- **F1 — `createTransaction` could consume the payment boundary.** A record
  carrying a `paymentRef` occupied the global boundary without crediting, so
  the real delivery replayed against it and credited nothing, forever. Both
  adapters now refuse a non-blank `paymentRef` with `UNSUPPORTED_OPERATION`
  (new `assertUnreferencedDirectTransaction` in `core/payment-ref.ts`) and
  normalise a blank one to absent. Memory's internal writer split into a
  private `recordTransaction` so `addCreditsV2` keeps writing referenced rows.
- **F2 — a refused payment created the account it refused to credit.** The
  drizzle `addCreditsV2` ensured the `credit_balances` row before the arbiter
  decided, and returning the `replayed`/`conflict` resolution committed that
  row. The resolution is now thrown out of the transaction as a sentinel
  (`PaymentAlreadyResolved` in `repository/add-credits.ts`) and returned from
  outside, so a rejected delivery rolls back every write.
- **F3 — `updateReservationStatus` bypassed the V2 state machine.** It now
  refuses any row carrying `holdPlacedAt` and refuses `reserved` on every row
  (new `assertDirectStatusWriteAllowed` in `core/reservation-integrity.ts`);
  drizzle additionally predicates its UPDATE on `hold_placed_at is null`.
- **F4/F5 — resets and downgrades unbacked live holds.** The monthly reset,
  subscription-expiry downgrade and `updateUserTier` could write a balance
  below `reserved - bonusCredits`, stranding every outstanding commit at
  INSUFFICIENT_CREDITS. All are floored at the new
  `backedBalanceFloor(reserved, bonusCredits)` (`core/amount.ts`); in SQL the
  floor is `greatest(reserved - bonus_credits, 0)` computed inside the UPDATE
  from the row's own columns, so it cannot race a concurrent reserve.
- **F8 — the unusable-index repair hint was not schema-qualified.** The
  catalog read now joins `pg_namespace` and the hint prints
  `DROP INDEX "schema"."name"`, so an operator paste cannot resolve through
  `search_path` to a same-named index elsewhere.
- **F10 — adapter divergence on the first credit for an unknown user.**
  Memory's `addCreditsV2` threw USER_NOT_FOUND where SQL ensure-created; both
  now create at `getDefaultTier()` — after the reference check, so a
  `replayed`/`conflict` resolution writes nothing, not even the account row.
  Drizzle's `ensureUserCredits` also creates at `getDefaultTier()` instead of
  hard-coded `'free'`.
- **F9 (docs) — the interface said `createReservation` was "phase 1 of a
  two-phase commit".** `repository/types.ts` now documents it as record-only,
  names `UNBACKED_RESERVATION` as the refusal every transition gives its rows,
  and points at the atomic reserve paths. **Semver note:** callers who used
  `createReservation` + `updateReservationStatus` as a hold mechanism are
  behaviourally broken by 1.8.0 (they were silently broken before — the guards
  make it loud). Flagged to the release owner as a candidate for a major bump.

### Adjudicated, not fixed

- **F6 — the reset journal is written outside the reset's atomic step**
  (memory adapter): a crash between the balance write and the journal append
  loses the journal line, not the money. Deferred; the drizzle adapter journals
  inside the transaction. Residual risk accepted for 1.8.0 and recorded here.
- **F7 — the `hold_placed_at` backfill certifies legacy rows** as holds. This
  is the deliberate, documented trade-off from the third round: the
  alternative strands every genuine in-flight hold a deployment already has.
  Not worse than 1.7.0, which had no such fact at all. Operators who want to
  audit instead can run, before migrating:
  `SELECT id, user_id, amount FROM credit_reservations WHERE status = 'reserved'`
  and reconcile against `credit_balances.reserved` per user; rows that do not
  sum to `reserved` are records, not holds, and can be released first.

### Verification (2026-08-28, after the fixes)

- `pnpm -r typecheck` — clean (10/10 packages)
- `@nehorai/credits` — 314/314 (18 files; +10 in
  `unit/direct-writers.test.ts`, +6 in `unit/hold-backing.test.ts`)
- `@nehorai/credits-drizzle` — 202/202 against real PostgreSQL 14.24 (17
  files; +5 in `integration/direct-writers.test.ts`, +4 in
  `integration/hold-backing.test.ts`); the SQL-level proof that a
  conflict/replay rolls back the ensured account row lives there
- `@nehorai/credits-firestore` — 88/88 (unchanged; no V2 surface)
- Nothing was published.
