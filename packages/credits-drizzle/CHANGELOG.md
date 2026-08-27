# @nehorai/credits-drizzle

## 0.2.0

**Requires a schema migration** (see README) and changes two observable
behaviours, hence the minor bump on a 0.x package rather than a patch.

### Added

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
  SQL (`CREDITS_V2_MIGRATION_SQL`, `CREDITS_V2_INDEXES_BLOCKING_SQL`,
  `CREDITS_V2_CONSTRAINTS_SQL`, `creditsV2MigrationScript`) for apps that do not
  use drizzle-kit. Every statement is individually idempotent.
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
- Calling a V2 method before the migration has been applied throws
  (`there is no unique or exclusion constraint matching the ON CONFLICT
  specification`) rather than silently placing duplicate holds. This is
  deliberate: a half-applied migration fails loudly instead of corrupting
  balances.
