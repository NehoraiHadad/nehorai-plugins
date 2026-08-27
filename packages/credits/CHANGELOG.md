# @nehorai/credits

## 1.8.0

> Two independent adversarial reviews blocked this release before it shipped,
> and a third, fully external audit (Codex) blocked it again after that.
> **Thirteenth review pass** lists what the external audit found; **Second
> review pass** lists what the second one found; **Release-blocker fixes**
> lists the first. Nothing shipped in between, so this is all one release.

### Thirteenth review pass (external audit)

An independent external audit returned a do-not-ship verdict with ten
findings. Seven are fixed below (three of them in `@nehorai/credits-drizzle`),
one was documentation, and two are adjudicated residual risks recorded in
`docs/TASKS-credits-v2-idempotency.md`.

- **A record cannot consume the payment boundary.** `createTransaction` writes
  a ledger record and credits nothing — but it accepted a `paymentRef`, so a
  record carrying one occupied the global boundary and the real delivery via
  `addCreditsV2` matched it, reported `replayed`, and credited nothing,
  forever. `createTransaction` now refuses any non-blank `paymentRef` with
  `UNSUPPORTED_OPERATION` (new `assertUnreferencedDirectTransaction`), and a
  blank one is normalised to absent instead of stored raw.
- **A record cannot impersonate a state transition.** `updateReservationStatus`
  assigned any status to any row: writing `committed` onto a live V2 hold
  stranded `reserved` (the real commit then said `already_terminal` and never
  debited), and writing `reserved` onto a terminal row re-armed a settled
  reservation. It now refuses any row carrying `holdPlacedAt` and refuses the
  `reserved` status on every row (new `assertDirectStatusWriteAllowed`);
  terminal statuses on plain records still work.
- **Balance reductions never cut through the credits that back live holds.**
  Commit's funding guard is `balance + bonusCredits >= amount`, so any write
  that lowers `balance` below `reserved - bonusCredits` strands every
  outstanding hold at INSUFFICIENT_CREDITS. Three writers could do that — the
  monthly reset, the subscription-expiry downgrade, and `updateUserTier` — and
  each is now floored at the new `backedBalanceFloor(reserved, bonusCredits)`.
- **The first credit for an unknown user creates the account.** The in-memory
  `addCreditsV2` threw `USER_NOT_FOUND` where the SQL adapter ensure-created
  the row, so a webhook that outran provisioning credited on one adapter and
  failed on the other. It now creates the account at tier defaults
  (`getDefaultTier()`), after the reference check — so a `replayed` or
  `conflict` resolution still writes nothing, not even the account row.
- **The repository interface says what the direct writers are.**
  `createReservation` is documented as a record-only API — it never touches
  `reserved`, every V2 transition refuses its rows with `UNBACKED_RESERVATION`,
  and the atomic reserve paths are the only way to place a hold. Code that
  used `createReservation` + `updateReservationStatus` as a two-phase commit
  was silently broken by 1.8.0's integrity guards; it is now loudly broken at
  the call site with a documented migration path.
- **New public surface**: `assertUnreferencedDirectTransaction`,
  `assertDirectStatusWriteAllowed`, `backedBalanceFloor`.

### Twelfth review pass

Two of these move money; the rest make the boundary honest about what it knows.

- **A reservation row is not a hold.** `createReservation` writes a row and never
  touches `reserved`, so a row it wrote carrying an idempotency key was found by
  `reserveCreditsV2`, reported as `replayed`, and committed — passing the
  `reserved >= amount` guard on coverage belonging to a *different*, genuine
  hold. Two holds, one payment. The invariant is now explicit and persisted: a
  row is a reservation only if the same atomic operation that wrote it also
  raised `reserved` by its amount, recorded as `PortableReservation.holdPlacedAt`
  and written by the atomic reserve alone. `createReservation` refuses an
  `idempotencyKey` outright (`UNSUPPORTED_OPERATION`), and every transition —
  plus the replay adoption itself — refuses a row without the fact
  (`UNBACKED_RESERVATION`), before any state changes. New
  `core/reservation-integrity.ts` holds both halves.
- **`paymentRef` is a global, semantic idempotency boundary.** It was scoped per
  user in memory and globally in SQL, so the same webhook replayed against a
  second account credited twice here and no-opped there. It was also compared on
  presence alone, so a redelivery carrying a *different* amount was accepted as a
  replay of the first. And an empty or whitespace-only reference was falsy for
  the check and truthy for the write. A reference now resolves to exactly one of
  `created`, `replayed` or `conflict` (`addCreditsV2`), is normalised in one
  place, and is compared on the canonical payload — user, amount on the cent
  grid, type, source, reference type — with `description` deliberately excluded
  because a retry may legitimately regenerate it. A conflict writes nothing.
  `addCreditsAtomic` keeps its `void` signature and now throws
  `IDEMPOTENCY_CONFLICT` instead of returning silently, which was
  indistinguishable from "credited".
- **A corrupt persisted status is quarantined, not cast.** The transitions wrote
  `status as ReservationStatus` and reported `already_terminal` — a *success*
  outcome — over whatever the row held, so `'RESERVED'`, `'pending'` or `''` read
  back to the caller as resolved. Unknown statuses now raise
  `CORRUPT_RESERVATION_STATUS` naming the user, row, transition and allowed set,
  ahead of every early exit including `not_due`, and change nothing.
- **One contract for an unlimited tier's monthly reset.** `monthlyResetBalance`
  is the single definition — a metered tier resets to exactly its configured
  limit, an unlimited tier to *at least* `UNLIMITED_BALANCE_SENTINEL` — so a
  degraded unlimited account recovers instead of staying at zero, and a
  topped-up one is not cut down.
- **New public surface**: `addCreditsV2` / `AddCreditsOutcome` /
  `isCreditedOutcome`, `ICreditRepositoryCreditsV2` and `supportsIdempotentCredit`,
  `addCreditsThroughRepository`, `normalizePaymentRef` /
  `describePaymentMismatch`, `monthlyResetBalance`, and the reservation-integrity
  assertions. `CreditsService.addCredits` now returns the outcome rather than
  `void`; a repository with no `addCreditsV2` still works through the legacy
  path, which carries no deduplication guarantee and says so.

### Eleventh review pass

- **`logUsage` returns a copy too**, the last write path still handing back its
  stored record.
- **One snapshot helper, not two.** The V2 transitions had their own private
  `snapshot()` doing the same shallow copy as `copyRecord`; they now share
  `repository/memory/snapshot.ts`, which also copies `metadata` a level deeper.

### Tenth review pass

- **The last derived-money sites now sum on the cent grid**: the exported
  `getTotalCredits` helper, and the running `creditsReleased` total in both
  expiry sweeps (expiring holds of 0.10 and 0.20 reported
  `0.30000000000000004`).
- **Every in-memory read returns a copy**, not just `getUserCredits`:
  reservations, transactions, journal entries, usage logs, the `getAll*` test
  helpers, and `metadata` one level deeper. `metadata` is also copied on the way
  *in*, so a caller that keeps its object and mutates it cannot rewrite a record
  already in the ledger. The new `repository/memory/snapshot.ts` holds the two
  helpers this uses.
- **An empty `paymentRef` means "no reference" in both adapters.** The SQL
  adapter skipped the duplicate check on it (falsy) and then stored it, so a
  replay hit the partial unique index and threw, while the in-memory adapter
  treated the same call as an idempotent no-op.
- **The amount documentation distinguishes moving from recording.** Both READMEs
  said zero and negative amounts are rejected before every write; the
  transaction and journal writers accept them deliberately — a release journals
  `amount: 0` and a corrected account has a negative `balanceAfter`.

### Ninth review pass

The eighth pass converted the derived totals in the adapters to `sumAmounts` but
missed the rest of the library. This pass extended it to the repositories and the
service; the **Tenth review pass** below finished the remaining sites and the
copy-on-read work this one started.

- **Every remaining derived-amount site sums on the cent grid**: the shared
  `availableCredits` helper in core, reservation `reserved` arithmetic in the
  in-memory V2 transitions, the split (balance-then-bonus) deduction, the
  service's balance/available/shortfall calculations, the monthly-reset delta,
  and every `shortfall` in the error helpers. Holding 0.10 and then 0.20 used to
  refuse the second hold; releasing 0.10 from 0.30 used to refuse the release.
- **`sumAmounts` is documented as arithmetic, not validation.** Two off-grid
  inputs can cancel — `sumAmounts(0.005, -0.005)` is a representable `0` — so
  amounts read from storage must be validated as inputs with
  `assertValidStoredAmount`, not only as derived results. The previous comment
  claimed more than the function delivers.
- **The in-memory adapter returns copies of user records, not its live ones**
  (extended to every record type in the tenth pass below). It handed
  callers the stored object, so a "before" snapshot mutated under them. That is
  what silently suppressed the monthly reset's journal entry: the service
  compared the post-reset balance against a value that had already become the
  post-reset balance, got zero, and skipped the entry — while the SQL adapter,
  which maps each row into a fresh object, wrote it.
- **`addCreditsAtomic` honours `paymentRef` in the in-memory adapter.** It
  accepted the reference and ignored it, so a replayed webhook credited twice in
  tests and once in production against the SQL adapter's unique index.
- **Service journal entries record the ledger balance.** The subscription
  downgrade and the monthly reset recorded `balance` alone while add, deduct and
  the V2 transitions all record `balance + bonusCredits`, so one account's audit
  trail disagreed with itself whenever it held bonus credits. Same fix in
  `repository/flow.ts` for the legacy commit and release entries.
- **The downgrade description names the tier actually landed on**, instead of
  hard-coding "to free tier" — the downgrade target became configurable in the
  eighth pass.

### Eighth review pass

- **Derived amounts are summed on the cent grid, not in binary floats.** Every
  balance the library computes is validated against `numeric(12, 2)` before it
  is written, and `0.10 + 0.20` is `0.30000000000000004` while `0.30 - 0.10` is
  `0.19999999999999998` — neither on the grid. Ordinary, legal operations were
  therefore rejected as `INVALID_AMOUNT`: adding 0.20 to a 0.10 balance,
  deducting 0.10 from 0.30, incrementing a column, or committing a hold that
  splits across balance and bonus credits. The new `sumAmounts` sums whole cents
  and is exact for every value in range; it is used for every derived total in
  both adapters. It is arithmetic, not validation: off-grid input is passed
  through unchanged rather than repaired, but two off-grid values can cancel, so
  amounts read from storage are validated as *inputs* — with
  `assertValidStoredAmount` — rather than only as derived results.
- **An update carrying both an absolute field and its increment now means the
  same thing in both adapters.** `{ monthlyUsed: 5, monthlyUsedIncrement: 2 }`
  stored 7 in memory and 102 in SQL, because the SQL column expression read the
  stored row and discarded the absolute. The absolute now seeds the sum. The
  in-memory comment claiming its order "is the order PostgreSQL would evaluate
  them in" was simply false and is gone.
- **The SQL grace-period downgrade honours the configured default tier.** It
  hard-coded `'free'` while the in-memory adapter used `getDefaultTier()`, so an
  app with a different default downgraded users onto different tiers depending
  on which adapter it ran.
- **Reserve replay compares the raw persisted `numeric`.** It compared the
  mapped `Number`, and a legacy widened row holding `9999999999.9900001` maps to
  `9999999999.99` — so a retry for that amount was answered `replayed` against a
  row that does not hold it. It is now an `idempotency_conflict`.

### Seventh review pass

- **Every path that derives `monthlyLimit` from tier configuration now goes
  through `storedMonthlyLimit`.** (`updateUserCredits` and `updateUserTier`
  still store a caller-supplied limit verbatim — they are handed a value, not a
  tier, so there is no `Infinity` sentinel to resolve.) The
  fourth pass fixed `initializeUserCredits` and this changelog then claimed the
  contract held everywhere, which was not true. `CreditsService.updateTier`
  still wrote a literal `0` for an unlimited tier, under a "0 means unlimited"
  convention that no read path in this library implements — so upgrading a user
  to unlimited persisted a zero allowance. The grace-period downgrade in both
  adapters read the raw `monthlyCredits` config field, where `0` means unlimited
  in the *other* direction, and the downgraded balance is clamped to the limit,
  so a user landing on an unlimited default tier was zeroed. Both are fixed and
  pinned by `__tests__/unit/unlimited-tier-contract.test.ts`, which asserts the
  literal canonical value rather than comparing an adapter against itself.
- **A refused transition leaves the hold live.** The release and expire journal
  regressions asserted only `reserved`; they now assert the reservation's
  `status` and `completedAt` too, so a refusal that terminated the row while
  leaving the credits held would be caught.

### Sixth review pass

- **`updateUserCredits` is all-or-nothing.** It validated the increment-derived
  results but assigned the absolute fields to the live record first, so
  `{ monthlyUsed: 5, balanceIncrement: 0.01 }` against a balance at the ceiling
  threw on `balance` and left `monthlyUsed` at 5 — a value the caller had been
  told was not applied. The whole record is now projected onto a candidate,
  every numeric field is checked on the candidate, and the record is swapped in
  only if all of them pass.
- **A refused transition journal names the transition.** The `balanceAfter`
  guard reported `field: 'journal balanceAfter'` without saying whether a
  commit, a release or an expire had been refused. `operation` is now threaded
  through the journal write in both adapters.

### Fifth review pass

- **The journal's `balanceAfter` is validated with the balances.** Every
  transition records a derived *total*, and validating `balance`,
  `bonusCredits`, `reserved` and `monthlyUsed` individually said nothing about
  their sum: with balance and bonus each legally at the ceiling, the recorded
  total was roughly twice what the column can hold. The SQL adapter already
  rejected it and rolled back; the in-memory store wrote it. The check now lives
  in `planTransitionJournal`, the one preflight every transition passes through
  before the ledger moves, so a transition added later cannot forget it.

### Fourth review pass

- **Derived values are projected before anything is written.** `addCreditsAtomic`
  moved the balance and only then validated the derived transaction record, so a
  refusal could leave the store holding half of a failed operation.
  `updateUserCredits`, `deductCreditsAtomic`, `reserveCreditsV2`,
  `commitReservationV2`, release and expire all now compute every derived value,
  validate them together with the field and operation named, and assign only
  after. There is no transaction to roll back in this adapter, so ordering is
  the only protection available.

  `updateUserCredits` needed a second pass: it validated the increment-derived
  results but assigned the *absolute* fields first, so `{ monthlyUsed: 5,
  balanceIncrement: 0.01 }` at the ceiling threw on `balance` and left
  `monthlyUsed` at 5. It now projects the entire record — absolute fields,
  increments, tier and timestamps — validates every numeric field on the
  candidate, and swaps it in only if all of them pass.
- **One contract for unlimited tiers.** `storedMonthlyLimit` maps the `Infinity`
  sentinel to the top of the representable range. `initializeUserCredits` in
  both adapters was fixed here; the SQL adapter previously stored `0`, meaning
  the same tier behaved as unlimited in tests and as zero-allowance in
  production. Three further writers of this column were still resolving the
  sentinel their own way and are fixed in the **Seventh review pass** below.
- **`assertValidStoredAmountRaw`** validates a persisted amount in the
  representation storage returned, for adapters whose storage is not JS numbers.
  Checking the converted value cannot detect corruption the conversion hides.

### Third review pass

- **The in-memory adapter validates the same public writers the SQL one does.**
  `initializeUserCredits`, `updateUserCredits`, `updateUserTier` and `logUsage`
  now reject unrepresentable amounts with `INVALID_AMOUNT` naming the field, so
  a test suite running against the in-memory repository fails on the same inputs
  production would. Zero and negative *increments* stay legal — they are how a
  balance goes down.
- **Commit's journal metadata records the amount that actually moved.** Caller
  metadata is merged first and the deterministic `operationType`/`amount` last,
  so a caller cannot name an amount the transition never moved. Release and
  expire already did this; the legacy (non-V2) commit path did not, and now does.
- **Corrupt stored amounts are refused before the early exits.** Commit, release
  and expire validated the locked amount only after returning `already_terminal`
  or `not_due`, so a reservation whose stored amount was unusable could still be
  reported as a success. Validation now runs immediately after the row is read,
  for every status, on both adapters.
- **Legacy `releaseCredits` is a no-op for a terminal reservation, whatever the
  adapter does.** It still calls through to `releaseReservationAtomic` for
  adapters that reconcile there, but a refusal is no longer propagated — the
  conflict is what the `already_terminal` outcome reports, and
  `releaseCreditsDetailed` still surfaces it.
- **Tier-derived limits are validated.** `assertRepresentableTierAmount` checks
  values read out of tier configuration, allowing `Infinity` as the unlimited
  sentinel and rejecting anything else `numeric(12, 2)` cannot hold.
- `assertRepresentableFields` validates a whole set of optional numeric fields
  at once, skipping `undefined`, so both adapters check identical field names.

### Second review pass

- **A corrupt stored reservation amount can no longer mint credits.** Every V2
  transition re-validates the amount it read back, *before* the compare-and-set
  and before any balance write. A reservation persisted with `-10` — by an older
  version, a repair script, a hand-run `UPDATE` — used to satisfy
  `reserved >= amount` trivially and then *add* credits on commit. Commit,
  release and expire now all raise `INVALID_AMOUNT` with
  `details.reason = 'corrupt_stored_amount'` and change nothing: no balance, no
  reserved counter, no monthly usage, no status, no journal row.
  - This deliberately refuses release and expire too. A row whose amount is not
    a real amount cannot be handed back any more safely than it can be spent —
    `reserved - (-10)` manufactures coverage nothing paid for. The row stops
    moving and waits for an operator, who should correct the amount (or
    reconcile `reserved` from the remaining valid holds) and then release it.
    Applying `CREDITS_V2_CONSTRAINTS_SQL` stops such a row being written at all.
- **`createReservation` validates its amount and key.** The public repository
  primitive accepted anything and wrote it, which is how a corrupt row got there
  in the first place. It now applies the same `assertValidCreditAmount` as every
  other writer.
- **Amount validation is applied wherever a credit amount is written**, not just
  at the service's front door: `CreditsService.addCredits` and `deductCredits`,
  and the in-memory repository's `addCreditsAtomic`, `deductCreditsAtomic`,
  `createReservation`, `createTransaction` and `createJournalEntry`. A direct
  repository caller gets the same guarantees as a service caller.
  - **Behaviour change:** `deductCredits(1.005)` and `deductCredits(Infinity)`
    used to reach the arithmetic; they now raise `INVALID_AMOUNT`. `amount > 0`
    was the only check before. Amounts computed by float arithmetic that land
    off the cent grid (`0.1 + 0.2`) are rejected rather than silently rounded by
    the column — round to cents before calling.
  - Ledger *records* (`createTransaction`, `createJournalEntry`) are checked for
    representability instead: a correcting entry may be negative and a
    `balanceAfter` may be below zero, but neither may be non-finite or off the
    cent grid.
- **In-memory journal keys are registered and enforced.** `createJournalEntry`
  stored an idempotency key without recording it, so a later V2 transition
  computing the same deterministic key wrote a *second* row — the ledger
  recorded one event twice and the two adapters disagreed about what happened.
  The key now goes into the same registry the transitions consult, and a
  duplicate raises `DATABASE_ERROR`, mirroring the SQL partial unique index.
- **The transitions' journal-key namespace is reserved.** Keys beginning
  `reservation:` (`RESERVED_JOURNAL_KEY_PREFIX`) can no longer be written
  through the public `createJournalEntry` on either adapter. Without that, a
  caller could pre-seed an exactly-matching `reservation:<id>:commit` row and
  have the commit adopt it as its own retry: the reservation would flip to
  committed and the balance would move, while the only journal row was the
  caller's.
- **The in-memory journal collision check runs before any mutation.** The store
  has no transaction to roll back, so a throw after the balance moved would
  leave a half-applied transition. The write is now split into a pure preflight
  that may refuse and a write that cannot, and the balances it journals are the
  same values it stores — assigned verbatim, so float re-association cannot make
  the recorded number differ from the stored one in the last bit.
- **Empty idempotency keys are rejected, consistently.** `''` and
  whitespace-only keys raise the new `INVALID_IDEMPOTENCY_KEY` instead of being
  stored by one adapter and treated as absent by the other. Keys are *not*
  trimmed: normalising `' job-1 '` to `'job-1'` would silently share a hold
  between two callers who each believe they own a distinct key.
- **Deterministic journal metadata cannot be overwritten by caller metadata.**
  Every journal construction spreads caller metadata first and writes
  `operationType`/`amount` last, so `metadata: { operationType: 'spoofed' }`
  cannot change the semantic identity the collision check compares on. Those two
  keys are reserved within transition journal metadata.
- `22003 numeric_value_out_of_range` is classified as `INVALID_AMOUNT` with
  `details.reason = 'amount_out_of_range'` rather than `DATABASE_ERROR`.
  Validating the operands cannot prevent it — `9999999999.99 + 0.01` is two
  valid amounts whose sum the column cannot hold.
- `getSqlState` walks the `cause` chain, so a driver error rewrapped by a pool
  or an ORM is still classified by its real SQLSTATE instead of being read as
  having none.
- **New error code `INVALID_IDEMPOTENCY_KEY`.** Additive, but if you `switch`
  exhaustively over `CreditErrorCodeType` with a `never` check, you will need a
  new branch.

**Retracted from the previous report:** the earlier pass recorded corrupt stored
amounts as an acceptable residual. That was wrong — it was the mint bug — and it
is fixed above.

### Release-blocker fixes

- **A legacy adapter given an `idempotencyKey` now refuses instead of lying.**
  The key was silently dropped and the call reported `created`, so a retry
  placed a second hold and charged the user twice while looking successful. It
  now throws `UNSUPPORTED_OPERATION` *before* attempting the reserve. Check
  `supportsCreditsV2(repo)` if you need to branch.
- **A legacy infrastructure failure is no longer relabelled as insufficient
  credits.** The fallback caught *any* error, read the balance, and returned
  `insufficient` whenever that balance happened to be low — turning connection
  drops and driver faults into a spurious "you are out of credits". Only a
  genuine `INSUFFICIENT_CREDITS` error is converted now; everything else
  propagates unchanged.
- **`releaseCredits` throws `RESERVATION_NOT_FOUND` again**, matching the
  pre-V2 behaviour it had quietly dropped. Releasing a reservation that is
  already terminal — `released`, `expired` or `committed` — stays an idempotent
  no-op, also matching pre-V2. Use `releaseCreditsDetailed` when you need to
  know that a concurrent commit won.
- **Amounts are validated against the ledger's `numeric(12, 2)` domain** before
  any write, in core so every adapter agrees: non-finite, non-positive,
  over-precision (more than two decimals) and out-of-range values raise
  `INVALID_AMOUNT`. New helpers `isValidCreditAmount`, `assertValidCreditAmount`,
  `toCents`, `numericToCents` and `sameAmount` — the last two compare values
  read back from `numeric` as exact integer cents rather than as floats.
- **In-memory balance invariants fail closed.** Like the SQL adapter, the
  in-memory repository now requires `reserved >= amount` on commit, release and
  expire, and raises `DATABASE_ERROR` rather than clamping the counter to zero
  and consuming other holds' coverage.
- The unsupported-idempotency-key refusal is raised **before** amount
  validation, so a caller who asked for a guarantee this repository cannot give
  hears that first rather than discovering it after fixing the amount.
- The legacy commit/release paths now **document that they cannot promise a
  single winner** — they read then write with no lock or CAS between, so
  `committed` there means "this call did the work", not "only this call did".

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
