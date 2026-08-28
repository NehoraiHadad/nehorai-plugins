---
name: sumit-payments
description: >-
  Wire SUMIT (UPAY) hosted-checkout payments into an app using the
  @nehorai/payments + @nehorai/payments-sumit plugins. Use whenever the user adds
  paid unlocks/subscriptions, debugs a SUMIT checkout / verify-on-return /
  webhook, sets up a SUMIT test org, or rolls SUMIT to production — even if they
  only say "add payments", "let users buy credits", or name SUMIT/UPAY without
  mentioning the plugin. Covers the one-business-many-products model, the
  verify-on-return grant path, and the known SUMIT gotchas that have burned us.
---

# SUMIT payments integration

You are wiring SUMIT (UPAY) into one of Nehorai's apps. The plugin speaks SUMIT;
**entitlements / credits / plans / users live in the app**, not the plugin. Your
job is the thin seam between them: take SUMIT's confirmation and grant the
entitlement idempotently.

## Sources of truth (read first)
- **Bundled recipe — read this before writing code:** `references/billing-sumit.md`
  (next to this file). It is the full production-grade wiring distilled from a
  live test-org E2E: install/config, the verify-on-return grant path, exactly
  what the redirect and `/get/` return, invoices/refunds, prod checklist, and
  test-org setup. This skill body is the *summary*; the reference is the detail.
- Canonical copy of that recipe (when working inside the plugins monorepo):
  `packages/payments-sumit/docs/billing-sumit.md`. Keep the two in sync if you
  edit one.
- Plugin internals (when you need the actual API surface): the published
  `@nehorai/payments` + `@nehorai/payments-sumit` packages — read their `.d.ts`
  in `node_modules` rather than guessing method names.

## Reference implementation
The shape to reproduce in any consuming app (names differ per app, so treat this
as a structure, not paths to copy literally):
- a server-only config module (lazy env read, throws if creds missing),
- a thin adapter wrapping the package's `SumitProvider`,
- a verify-on-return module (the blocking checks below),
- an idempotent fulfilment/grant module,
- routes: `checkout` (create + redirect), `orders/[id]/verify` (grant on return),
  and a backup `webhooks/sumit` route.

## Non-negotiables (each one has burned us)
1. **One SUMIT account per legal business, NOT per product.** Same CompanyID +
   APIKey across all apps; separate products via your order UUID
   (`ExternalIdentifier`) + per-charge item description. The business name stays
   generic (never a product name). Test and prod are separate orgs with separate
   keys.
2. **Charge mapping:** amount goes in `ChargeItem.UnitPrice` (required), set
   `VATIncluded: true` for VAT-inclusive prices (SUMIT defaults to `false` and
   would add VAT on top, e.g. ₪49 → ₪57.82, which then fails your amount check),
   amounts in **major units** (shekels, not agorot). Plugin ≥ 0.2.1.
3. **Grant = verify-on-return (primary).** SUMIT has no signed webhook. Read
   `OG-PaymentID` from the redirect → server calls `/billing/payments/get/` →
   block the grant unless ALL hold: `ValidPayment === true` **and**
   `Amount * 100 === orders.amount_minor` (the security anchor) **and** that
   paymentId has not already settled another order (replay guard) **and** the
   order is still pending and scoped to this app. Only then grant, idempotently.
   The webhook (`?token=` constant-time compare) is **backup only**.
4. **Invoice number comes from the redirect's `OG-DocumentNumber`**, NOT from
   `/get/` (which lacks both `ExternalIdentifier` and `DocumentNumber`, and
   returns `Currency` as a numeric enum where `0` = ILS). Read all redirect
   params **case-insensitively** — casing has varied.
5. **SUMIT auto-issues + emails the invoice** (חשבונית מס/קבלה) on payment — do
   not wire a second invoicer for SUMIT orders; just backfill the document
   number. Refunds are **dashboard-only** → record a matching ledger row by hand.
6. **Prod prerequisite:** the business needs complete details (סוג עוסק, מספר
   עוסק, טלפון, כתובת) or `beginredirect` 500s with "Missing organization
   details (Corporate Number / Phone Number)".
7. **Secrets stay server-side.** Keep `SUMIT_API_KEY` server-only (never
   `NEXT_PUBLIC`). Never type card numbers or API keys into forms on the user's
   behalf — have the user do that themselves.
8. **Grant idempotently, and self-heal.** The return leg and the backup webhook
   BOTH fulfil the same order, so route them through ONE shared function. Flip the
   order `pending → paid` inside a transaction (single writer) and gate the actual
   credit grant on a SEPARATE `credits_granted` flag — not on `status` — so that if
   the grant throws *after* the status flip, the flag stays false and the other leg
   (or a retry) re-grants. Combine with the replay guard (rule 3: one paymentId
   settles one order) and the provider's own grant idempotency key. Net: a webhook
   redelivery never double-grants, and a verify-on-return grants even if the webhook
   never arrives.
9. **Always send a customer name** — pass `metadata.customerName` on EVERY
   `createPaymentIntent` / `createSubscription` call, in BOTH the one-time-pack and
   the subscription flow (the plugin maps it to SUMIT's `Customer.Name`). Resolve
   it once via a shared helper whose fallback chain never yields empty:
   `user_metadata.full_name` → `user_metadata.name` (Google OAuth) → `email`.
   Without a name SUMIT labels the auto-created customer **"כרטיס ללא שם"**, and
   it's easy to wire one route and miss the other. If the app doesn't collect a
   name, add it: a signup field stored in `user_metadata.full_name` (instantly
   readable from the session, no DB round-trip), plus a best-effort sync to your
   profile/display-name table — **upsert** (profiles are usually created lazily, so
   plain update no-ops), on BOTH password signup AND the OAuth callback, the
   callback one gated `onlyIfEmpty` (`setWhere` is-null) so a later login never
   clobbers a name. The profile sync must be best-effort: a failure there must
   never fail signup/login (the auth user already exists).

## Env
`SUMIT_COMPANY_ID`, `SUMIT_API_KEY`, `SUMIT_WEBHOOK_TOKEN`, optional
`SUMIT_API_BASE` (defaults to `https://api.sumit.co.il`), plus your provider
switch (e.g. `PAYMENT_PROVIDER=sumit`) with a fallback configured for instant
rollback.

**Test vs prod = inject different VALUES per environment, NOT a `NODE_ENV` code
branch.** SUMIT test and prod are separate orgs with separate keys; keep ONE set
of var names and set the test org's values where you don't want real charges and
the prod org's values in production. On Vercel: set test values in the **Preview +
Development** env scopes and prod values in the **Production** scope. ⚠️ Do NOT
select with `process.env.NODE_ENV` — Vercel runs Preview deploys with
`NODE_ENV=production`, so a `NODE_ENV === "production" ? prod : test` selector
makes **previews charge real cards**. (If you must branch in code, branch on
`VERCEL_ENV`, not `NODE_ENV`.)

## Plugin helpers to prefer (don't hand-roll these)
- **Verify-on-return:** `provider.verifyPayment({ paymentId, expectedAmountMinor })`
  → `{ verified, valid, amountMatches, amountMinor, payment }`. `verified` bakes in
  the `ValidPayment === true` **and** amount-anchor check — gate your grant on it
  instead of re-implementing the comparison around `getPayment`.
- **Backup webhook route:** for simple apps, use
  `createTokenWebhookRouteHandler({ services, provider:'sumit', getWebhookSecret,
  onEvent })` from `@nehorai/payments-nextjs/handlers`. For subscription apps or
  any app that needs explicit retry semantics, write a thin manual route: verify
  the shared URL token with `SumitProvider.validateWebhookSignature`, parse with
  `services.webhookHandlers.get('sumit').parseEvent(payload)`, insert a unique
  event row first, then call the app fulfilment core. If fulfilment throws, delete
  the event row and return 500 so SUMIT can retry. Do NOT use
  `createWebhookRouteHandler` for SUMIT — that one is HMAC/header-based and its
  `processEvent` grants nothing.

## Recurring monthly subscriptions (Flow B: hosted first charge + deferred standing order)
The catalog is **ILS (₪)** — one-time packs ₪35/₪90/₪250 (named by quantity:
100/300/1,000 Credits); subscription plans Basic ₪29.90 / Premium ₪79.90 /
Pro ₪199 per month (named by plan name). Prices live in the app's
`plans.ts`/`products.ts`; `operationCosts` + per-tier `monthlyLimit` are
owned by the consuming app's credits configuration.

Reference apps use **Flow B**, not per-plan SUMIT Payment Pages. Start with
`createPaymentIntent` / `/billing/payments/beginredirect/` for cycle 1; do **not**
set `preventSavingPaymentMethod` for subscriptions, so SUMIT saves the card on its
side and returns `OG-CustomerID`. If the app already has a `providerCustomerId`,
pass it as `metadata.providerCustomerId` so beginredirect reuses that SUMIT
customer (`Customer: { ID }`) while staying on hosted checkout. After
verify-on-return succeeds, call
`createSubscription({ providerCustomerId, startDate: +1 month, externalIdentifier:
subscription/order id })` to create the deferred monthly standing order via
`/billing/recurring/charge/`. Cancel via the published `cancelSubscription`
(numeric `RecurringCustomerItemID`, plus `providerCustomerId` when available).

**Grant model (recurring) = 3 layers, every grant gated on a LIVE SUMIT confirm
(never elapsed time):** (1) webhook → verify (`getPayment` → `ValidPayment===true`
+ amount-anchor) → grant; (2) reconcile-on-read (the backbone — when `nextChargeAt`
passed without a recorded cycle, query SUMIT on read and grant iff confirmed);
(3) thin optional cron for inactive users. Renewals normalize to
`subscription.renewed` / `subscription.payment_failed` / `subscription.canceled`,
recurring detected via `RecurringCustomerItemIDs`. **Per-cycle idempotency = the
charge-id ledger doc, NOT the subscription `status`** (a renewal hits an already-
active subscription).

**Credits grant shape matters:** one-time packs are purchased/admin credits, so
they should call `CreditsService.addCredits(...)` and increase `bonusCredits`.
Subscription cycles are monthly allowance reloads, so do **not** call
`addCredits` for renewals. Use the credits repository/service to set the user's
monthly `balance`, `monthlyLimit`, `monthlyUsed = 0`,
`subscriptionExpiresAt = periodEnd`, and park `monthlyResetAt` beyond
`periodEnd + grace` so an automatic monthly reset cannot mint credits without a
confirmed SUMIT charge. Keep any legacy app credit table synced from the plugin
balance only for backwards-compatible UI reads.

**Tiers are config-owned + type-safe:** `SubscriptionTier = BuiltinTier | (string &
{})`; adding a tier = config-only, no republish. Apps may map business plans
(`basic`, `pro`, `enterprise`) onto configured plugin tiers (`basic`, `premium`,
custom tiers, etc.) while storing the business plan id in the app subscription
record. Plans should gate on SUMIT credentials and app catalog availability, not
`SUMIT_SUB_PAGE_URL_*`.

> ⚠️ **Setup required before subscriptions work in prod** (per SUMIT org): enable
> API access and recurring/standing-order capability for the organization, use
> production `SUMIT_COMPANY_ID` + `SUMIT_API_KEY`, configure the shared-token
> webhook URL, and confirm live that future `Date_Start` defers the first standing
> order charge. No per-plan SUMIT Payment Pages are required for Flow B.

## Test org (no real charges)
org-switcher → "יצירת עסק חדש" (name must contain "בדיקות") → install the free API
module → connect a test terminal at `app.sumit.co.il/developers/testterminal`
(this disconnects real card processing, which is why it must be a separate org) →
mint a key at `/developers/keys/` → fill פרטי עסק (the מספר עוסק must be globally
unique in SUMIT). Test cards: `help.sumit.co.il/he/articles/5832877`.
