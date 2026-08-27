# @nehorai/credits

## 1.8.0

Additive. No existing API changed shape, and every legacy call path still
compiles and behaves as before.

### Added

- **V2 reservation boundary.** `ICreditRepositoryV2` defines four optional
  methods — `reserveCreditsV2`, `commitReservationV2`, `releaseReservationV2`,
  `expireReservationV2` — that return typed outcomes instead of throwing, so a
  caller can tell "someone else won this transition" apart from "this failed".
  `supportsCreditsV2(repo)` narrows a repository to the V2 surface.
- **Caller idempotency keys.** `reserveCredits`/`reserveCreditsDetailed` accept
  an `idempotencyKey`. A replay with the same user, amount, and operation type
  returns the original reservation; reusing the key with a different payload is
  a typed `IDEMPOTENCY_CONFLICT` rather than a silent second hold.
  `expiresAt` is deliberately excluded from the comparison, since a retry
  legitimately computes a later deadline.
- `CreditsService.reserveCreditsDetailed` / `commitCreditsDetailed` /
  `releaseCreditsDetailed`, returning `ReserveOutcome` / `CommitOutcome` /
  `ReleaseOutcome`.
- New `CreditErrorCode` values: `IDEMPOTENCY_CONFLICT`, `TRANSIENT_ERROR`,
  `UNSUPPORTED_OPERATION`, `INVALID_AMOUNT`, with matching constructors and the
  `isTransientError` / `isIdempotencyConflictError` guards.
- `classifyDatabaseError` and `isTransientDatabaseError`: driver-agnostic
  SQLSTATE classification (deadlock, serialisation failure, lock timeout,
  admin shutdown, connection loss) so callers know what is safe to retry. An
  error that is already a `CreditError` passes through untouched, so a domain
  outcome is never downgraded to `DATABASE_ERROR`.
- `reservationJournalKey(reservationId, transition)` — the deterministic journal
  key every V2 adapter must use, so a retried transition cannot double-journal.

### Changed

- **The service layer no longer writes a journal entry after a commit** when the
  repository implements V2. The repository writes the single authoritative entry
  inside the same transaction as the balance mutation. Previously both wrote
  one, producing two rows per commit on the Drizzle adapter. Legacy repositories
  are unaffected: the service still journals for them, exactly as before.
- The low-balance callback now fires only for a *winning* commit, and only after
  the transaction has committed — never for a duplicate commit, and never from
  inside a transaction.
- `InMemoryCreditRepository` was rebuilt on the V2 primitives. It now models row
  locks (a keyed mutex) and the partial unique indexes (keyed maps) rather than
  relying on JavaScript being single-threaded, so the shared contract tests
  actually exercise the concurrency guarantees.

### Notes

- `@nehorai/credits-firestore` is **not** part of this: it remains legacy-only,
  implements no V2 method, and gains no idempotency or single-winner guarantee.
  `supportsCreditsV2` returns `false` for it and callers keep the old path.
- `@nehorai/credits-nextjs` is unchanged and source-compatible. Its
  `withCredits` options are per-action rather than per-request, so it does not
  expose an idempotency key; use `CreditsService.reserveCredits` directly when
  you need one.
