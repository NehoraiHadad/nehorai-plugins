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

## Status log

- 2026-08-27: branch created, design memo obtained via outsourcerer (`sol`, high effort).
- 2026-08-27: all 14 subtasks complete. Verification below.

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

## Not done / out of scope

- Not published to npm, not pushed. Branch `codex/credits-idempotency` only.
- `@nehorai/credits-firestore` is legacy-only by decision. It implements no V2
  method and carries no idempotency or single-winner guarantee. Its 88 existing
  tests still pass; nothing about it was changed or claimed.
- `@nehorai/credits-nextjs` unchanged. Its `withCredits` options are
  per-action-definition, not per-request, so a static `idempotencyKey` there
  would dedupe every request forever. Per-request keys require calling
  `CreditsService.reserveCredits` directly.
