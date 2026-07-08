# nehorai-plugins — Upgrade Plan

Synthesized from two deep audits (credits side + payments side) run on 2026-07-07,
cross-referenced against the one real consumer (podcasto). Mission: make connecting
a payment provider and a credits mechanism to any app as close to drop-in as possible.

Execution model mirrors the podcasto polish: phased waves sized for Sonnet agents,
green gate (`pnpm build && pnpm typecheck && pnpm test` per touched package) between
phases, one commit per task.

## Headline findings

**Both families share the same three systemic gaps:**
1. **Typed errors are advertised but never constructed.** `PaymentError`/`PaymentErrorCode`
   (payments) and `CreditError`/`CreditErrorCode` (credits) exist and are exported, but
   every provider/adapter throws plain `Error` or returns ad-hoc `{success:false, error:string}`.
   This is what pushes consumer apps to degrade results to `T | null` (podcasto's
   `createDeferredStandingOrder` collapse) and to fragile message string-matching.
2. **Test coverage is inverted relative to risk.** `payments-sumit` (66+ tests) and
   `credits`/`credits-firestore` are covered; but `payments` core (state machine, circuit
   breaker, routing engine), `payments-stripe/il/nextjs/drizzle` and — worst —
   `credits-drizzle` (the backend podcasto actually runs in production, with the
   atomicity-sensitive SQL) have **zero tests**. No CI, no changelogs.
3. **The plugins stop one layer short of drop-in.** Apps must hand-roll: verify-on-return
   routes, webhook idempotency ledgers, SUMIT reconciliation (~325 lines in podcasto),
   credits REST routes (the SDK clients have no server), crons for reservation expiry /
   monthly reset, admin/React primitives, and legacy-table migration (podcasto dual-writes
   credits to two schemas indefinitely).

**Notable point findings:** Hyp's `validateHMAC` is a stub (`return !!signature`) — a
dormant security hole; `credits-drizzle` pins `@nehorai/credits@^1.5.0` instead of
`workspace:^` (dev/publish drift risk); three near-identical implementations of the
commit/release-with-journal flow have already drifted (idempotent-commit guard exists in
one of three); `notifications/` module is dead code marketed as a feature; sub-path
exports don't resolve under Next.js webpack (podcasto works around via barrel imports);
`payments-drizzle`'s J5 schema delivers zero value to the redirect/standing-order model
SUMIT actually uses.

Full agent reports (file-level citations for every claim) are preserved in the session
transcript; each backlog item below carries its origin.

## Phase 0 — Repo infrastructure (all S effort, do first)

- [ ] 0.1 CI: GitHub Actions running `pnpm build && pnpm typecheck && pnpm test` on PR/push
- [ ] 0.2 Normalize internal dependency pins to `workspace:^` everywhere
      (`credits-drizzle` → credits; `payments-drizzle`, `payments-sumit` → payments)
- [ ] 0.3 Adopt Changesets (or per-package CHANGELOG.md); backfill current versions
- [ ] 0.4 Add README for `credits-drizzle` (only adapter without one, and the one in production)

## Phase 1 — Correctness & security (highest risk/reward)

- [ ] 1.1 **Test suite for `credits-drizzle`**: concurrency stress on `reserveCreditsAtomic` /
      `commitReservationAtomic` / `deductCreditsAtomic`; mirror Firestore's test structure (M)
- [ ] 1.2 Tests for `payments` core: state machine, circuit breaker, routing engine, orchestrator (M)
- [ ] 1.3 **Fix Hyp `validateHMAC`** to compute/compare a real HMAC (currently accepts any
      non-empty string) (S)
- [ ] 1.4 State-machine guard for reservation transitions in `credits-drizzle`
      (Firestore has `validateTransition`; Drizzle only checks `status === 'reserved'`) (S)
- [ ] 1.5 Share `calculateCreditDeduction` between Firestore and Drizzle (Drizzle reimplements
      the split-deduction math inline) (S)
- [ ] 1.6 Tests for `payments-stripe`, `payments-il`, `payments-nextjs`, `payments-drizzle`
      using the `payments-sumit` test pattern as template (M)

## Phase 2 — Unified typed error/result model (the "null" fix)

- [ ] 2.1 Payments: construct `PaymentError` (+ `retryable` flag, `toPaymentError()` helper) on
      every provider failure path; deprecate ad-hoc `{success:false, error:string}` (M)
- [ ] 2.2 Credits: throw `CreditError` consistently from service, core/operations, and both
      adapters; make `isInsufficientCreditsError` code-based, not message-matching (M)
- [ ] 2.3 Capability flags on `IPaymentProvider`: `supportsRefund` / `supportsVoid`
      (+ `getProviderCapabilities()` helper) — unblocks real refund/void UX in apps (S)
- [ ] 2.4 Structured `errorCode`s for known SUMIT rejections (replace Hebrew-string matching) (S)
- [ ] 2.5 Widen `AIProviderType` from the single literal `"gemini"` (use the `string & {}`
      pattern already proven by `SubscriptionTier`) (S)
- [ ] 2.6 Fix sub-path export resolution under Next.js/webpack (reproduced in podcasto;
      investigate exports-map condition ordering / sideEffects) (M)

## Phase 3 — Consolidation (remove drift risk)

- [ ] 3.1 Collapse the three duplicate commit/release-with-journal implementations
      (`core/operations.ts`, `CreditsService`, `adapters/generic.ts`) into one source of truth;
      port the idempotent-commit guard everywhere (M)
- [ ] 3.2 Decide fate of `adapters/generic.ts` (superseded by `credits-nextjs`; unused by any
      consumer): rebuild credits-nextjs on top of it, or delete it (S–M)
- [ ] 3.3 `notifications/` module: wire it as the single notification mechanism (replacing the
      instance callbacks) or delete it and fix the README claim (S)
- [ ] 3.4 `payments-drizzle` schema story: document explicitly that the J5 ledger targets
      authorize/capture providers, and design/document the app-owned-schema pattern for
      redirect/standing-order providers (or ship a second schema set) (M)

## Phase 4 — Drop-in DX: absorb the boilerplate apps keep rewriting

- [ ] 4.1 `payments-nextjs`: `createVerifyReturnRouteHandler` factory (the most-repeated app
      code in SUMIT integrations) (M)
- [ ] 4.2 Generic `claimWebhookEvent()` idempotency helper on the drizzle webhook-events table (S)
- [ ] 4.3 Promote `createTokenWebhookRouteHandler` + verify-on-return as THE documented SUMIT
      path (top-level README, quick-start) (S)
- [ ] 4.4 Extract SUMIT subscription reconciliation into `payments-sumit` as a reusable
      higher-order function (due-scan, paged payment scan, amount-anchor matching, cooldown);
      podcasto's 325-line `sumit-reconcile-service` is the reference implementation (L)
- [ ] 4.5 Credits route-handler factories (`balance/reserve/commit/release/history` +
      admin endpoints) so `CreditsClient`/`AdminCreditsClient` finally have a server (L)
- [ ] 4.6 Idempotency-key support on `reserveCreditsAtomic`/`deductCreditsAtomic`
      (today only `addCreditsAtomic` has `paymentRef`) (M)
- [ ] 4.7 Legacy-table migration/coexistence tooling: documented dual-write → backfill →
      cutover pattern + helper; directly unblocks retiring podcasto's `userCredits` (L)
- [ ] 4.8 Cron-ready handlers for reservation expiry + monthly reset (route factories) (S)

## Phase 5 — New capabilities (optional, by demand)

- [ ] 5.1 Expiring credit batches (promotional credits, FIFO consumption) (L)
- [ ] 5.2 React hooks / client primitives (`useCreditsBalance`, low-balance banner) —
      possibly a `credits-react` package (M)
- [ ] 5.3 Subscription lifecycle state machine in `payments` core (mirror the J5 transaction
      state machine rigor) (M)
- [ ] 5.4 Generic mutation-event hooks on credits (Slack/webhook on any balance change) (M)
- [ ] 5.5 Split `ICreditRepository` query/reporting methods into an optional interface (M)
- [ ] 5.6 Real `getPaymentIntentStatus` for Hyp, or document webhook-as-sole-source (M)

## Consumer follow-ups (in podcasto, not this repo)

- Migrate `deductCreditsForOperation` to `@nehorai/credits@1.6.0` `deductCredits()` (atomic;
  published 2026-07-07) — closes the double-spend race.
- Fix `createDeferredStandingOrder` collapsing the typed `SubscriptionResult` into
  `string | null` (blocks fulfillment-on-failure bug); pairs with Phase 2.1.
- After Phase 4: replace hand-rolled SUMIT webhook route, verify-on-return, reconcile
  service, and webhook-events table with the plugin factories.

## Suggested execution order

Phase 0 → 1 are cheap and de-risk everything else; run first, single agent each.
Phase 2 next (it changes provider return contracts — do it before more consumers appear).
Phase 3 and 4 parallelize well per-package. Phase 5 by demand.
