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
      `indislive`, `indisunique`), drops an unhealthy index concurrently,
      rebuilds it, and verifies the catalog afterwards, failing with
      `CONFIGURATION_ERROR` naming the colliding keys if it cannot. `IF NOT
      EXISTS` was removed from the index SQL as defence in depth.
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
      `not_found` as it did before V2; already released/expired stays an
      idempotent no-op; a committed reservation throws
      `RESERVATION_ALREADY_PROCESSED`.
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
- `pnpm -r test` — 342 passing: credits 111, credits-drizzle 37 (real
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

## Not done / out of scope

- Not published to npm, not pushed. Branch `codex/credits-idempotency` only.
- `@nehorai/credits-firestore` is legacy-only by decision. It implements no V2
  method and carries no idempotency or single-winner guarantee. Its 88 existing
  tests still pass; nothing about it was changed or claimed.
- `@nehorai/credits-nextjs` unchanged. Its `withCredits` options are
  per-action-definition, not per-request, so a static `idempotencyKey` there
  would dedupe every request forever. Per-request keys require calling
  `CreditsService.reserveCredits` directly.
- Deliberately not implemented from the second opinion, and worth revisiting:
  treating a terminal status alone as an idempotent replay (without the journal
  key), reordering the reconciliation path behind an advisory lock, and adding
  an `UNKNOWN_OUTCOME` for a commit whose connection dropped mid-COMMIT. Each is
  a semantic change to the public contract rather than a blocker fix, so none
  belongs in this release.
