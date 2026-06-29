# Integrating `@nehorai/payments-sumit`

SUMIT (UPAY) hosted-redirect checkout for one-time purchases and subscriptions.
This is the integration recipe distilled from a full production-grade wiring +
live test-org E2E. The plugin speaks SUMIT; **credits/plans/entitlements/users
live in your app**, not here.

Reference shape (names vary per app): a server-only config module, a thin
`SumitProvider` adapter, a verify-on-return module, and an idempotent
fulfilment/grant module.

## 1. The model (one business, many products)

A SUMIT account **is a legal business** (עוסק/חברה) that issues tax documents.
Rule: **one SUMIT account per legal entity — NOT one per product.** All your
products (e.g. Story Creator, podcasToYOU) bill under the same business →
one set of books, one VAT report, one API account (CompanyID + APIKey), one UPAY.

Separate products in **your** system, not in SUMIT:
- `ExternalIdentifier` = your order id (UUID) — globally unique across all apps,
  no collision. Each app only looks up its own orders, so a foreign payment is
  simply ignored.
- Per-charge item `Description`/Name carries the product label (e.g. "Pro plan")
  → that is what shows on the invoice and the hosted page; the **business name**
  must stay generic, never a product name.

Test vs prod = **separate SUMIT orgs**, each with its own API key. Never put test
keys in production.

## 2. Install + configure

```bash
pnpm add @nehorai/payments @nehorai/payments-sumit
```

Wrap the package's `SumitProvider` in a thin server-only adapter that maps your
domain to the plugin and back. Config is read lazily from env (throw a
non-retryable error if missing — never ship blank creds):

```
SUMIT_COMPANY_ID=<numeric CompanyID from app.sumit.co.il/developers/keys/>
SUMIT_API_KEY=<private APIKey, server-only, NEVER NEXT_PUBLIC>
SUMIT_WEBHOOK_TOKEN=<random shared secret you invent, for the backup webhook>
# SUMIT_API_BASE optional (defaults to https://api.sumit.co.il)
```

**Test vs prod = inject different VALUES per environment, NOT a `NODE_ENV` branch.**
Test and prod are separate SUMIT orgs with separate keys. Keep ONE set of var
names; set the test org's values where you don't want real charges and the prod
org's in production. On Vercel: test values in the **Preview + Development** env
scopes, prod values in **Production**. ⚠️ Never select with `process.env.NODE_ENV`
— Vercel runs Preview deploys with `NODE_ENV=production`, so a NODE_ENV branch
makes **previews charge real cards**. Branch on `VERCEL_ENV` if you must branch at all.

Charge mapping that MUST be correct (verified against the live swagger; getting
these wrong silently overcharges or fails):
- Put the amount in **`ChargeItem.UnitPrice`** (a required field), not `Item.Price`.
- Send **`VATIncluded: true`** when your prices are VAT-inclusive. SUMIT defaults
  to `false` and would **add VAT on top** (₪49 → ₪57.82), which then fails your
  amount check. Plugin ≥ 0.2.1 does both correctly.
- Amounts cross the plugin boundary in **major units** (shekels), not agorot.

### Currency = ILS (₪)

SUMIT is an Israeli processor, so the whole catalog is priced in **shekels (₪)**.
USD/EUR survive only as a legacy entry in the currency type union
(`SUMIT_SUPPORTED_CURRENCIES = ['ILS', 'USD', 'EUR']`) — no live product uses them.

Current catalog (prices live in the **app's** code, `plans.ts` / `products.ts` —
not in this plugin):

| Kind | Items | Price |
| --- | --- | --- |
| One-time credit packs (named by **quantity**) | 100 / 300 / 1,000 Credits | ₪35 / ₪90 / ₪250 |
| Subscriptions (named by **plan name**) | Basic / Premium / Pro (monthly) | ₪29.90 / ₪79.90 / ₪199 |

Only **prices** live in code. `operationCosts` (credit cost per operation) and each
tier's `monthlyLimit` belong to the consuming app's credits configuration.

## 3. Grant path — verify-on-return is PRIMARY

SUMIT has **no signed webhook**. Official guidance: after the hosted-page
redirect, confirm the transaction server-side. So:

1. Hosted page redirects the browser back to your `successUrl` with query params
   (see §4). Read `OG-PaymentID`.
2. Your return page POSTs it to a server route that calls
   `/billing/payments/get/` (the plugin's `getPayment`) and applies **blocking**
   checks BEFORE granting (browser-supplied data is untrusted):
   - `ValidPayment === true`
   - `Amount * 100 === orders.amount_minor` (the security anchor)
   - one `provider_payment_id` can never settle two orders (replay guard)
   - order is still pending + provider is `sumit` + scoped to the workspace
3. Grant via your idempotent single-writer (e.g. a `grant_purchase` RPC).
4. The Triggers+Views webhook (`?token=` constant-time compared) is **backup
   only** and runs the same reconcile core.

For simple one-time flows the Next.js helper
`createTokenWebhookRouteHandler({ services, provider: 'sumit', ... })` is fine.
For subscriptions or any app that needs explicit retry semantics, prefer a thin
manual webhook route: verify the shared URL token with
`SumitProvider.validateWebhookSignature`, parse with
`services.webhookHandlers.get('sumit').parseEvent(payload)`, insert a unique
event row first, then call the app fulfilment core. If fulfilment throws, delete
the event row and return 500 so SUMIT can retry.

## 4. What the redirect/`/get/` actually return (verified live)

Redirect query (read keys **case-insensitively** — casing has varied):
```
?order=<yourOrderId>&internal_order_id=<yourOrderId>
&OG-CustomerID=…&OG-PaymentID=…&OG-PaymentType=CreditCard
&OG-ExternalIdentifier=<yourOrderId>&OG-DocumentNumber=<invoiceNo>
```
- **`OG-DocumentNumber` IS present on the redirect** (despite the swagger omitting
  it) — this is where the auto-issued invoice number comes from. `/get/` does NOT
  return it. Store it from the redirect.
- `OG-ExternalIdentifier` reliably echoes your order id on the redirect.

`/billing/payments/get/` → `Data.Payment` keys: `ID, CustomerID, Date,
ValidPayment, Status, StatusDescription, Amount, Currency, PaymentMethod,
AuthNumber, FirstPaymentAmount, NonFirstPaymentAmount, RecurringCustomerItemIDs`.
- **No `ExternalIdentifier`, no `DocumentNumber`** here → an ExternalIdentifier
  cross-check via `/get/` is inert; rely on amount-equality + reuse-guard.
- `Currency` is a **numeric enum (`0` = ILS)**, not a string — don't depend on it
  in any blocking check.

## 5. Invoices & refunds

SUMIT **auto-issues + emails** the חשבונית מס/קבלה on payment (enable in the
dashboard: auto-issue + email-to-customer ON). Your fulfilment only backfills the
document number (from the redirect's `OG-DocumentNumber`). Do not also call a
separate invoicing service for SUMIT orders. **Refunds are dashboard-only** —
record a matching refund row in your ledger manually.

## 6. Production rollout checklist

1. Real business has UPAY active + complete business details (סוג עוסק, **מספר
   עוסק**, טלפון, כתובת) — otherwise `beginredirect` 500s with "Missing
   organization details (Corporate Number / Phone Number)".
2. Mint a **new prod APIKey** (not the test key).
3. Apply any DB migration (e.g. provider enum) to staging then prod.
4. Set prod env vars; keep the previous provider configured for instant rollback.
5. Dashboard: auto-issue documents + email ON; (optional) Triggers+View webhook
   → `POST https://<domain>/api/webhooks/sumit?token=<SUMIT_WEBHOOK_TOKEN>`.
   Note: the webhook is **per-business / single URL** — for multi-app backup you
   need a small dispatcher, or just rely on verify-on-return (sufficient).
6. One small **real** payment, verify: paid → invoice → entitlement/credits →
   no duplicate → then refund from the dashboard.

## 7b. Recurring monthly subscriptions (Flow B)

> ✅ The reference apps use **Flow B**: hosted `beginredirect` charges cycle 1
> and saves the card at SUMIT; after verify-on-return, the app creates the
> deferred monthly standing order through `createSubscription`.

| Route | How | Card collection | Needs a token? |
| --- | --- | --- | --- |
| **Flow B (primary)** | `createPaymentIntent` for cycle 1 → verify → `createSubscription` with `providerCustomerId` + future `Date_Start` | on SUMIT's hosted checkout (PCI-safe) | **no app-held token** |
| Legacy Payment Page | `buildSubscriptionPageUrl` to a pre-built per-plan Payment Page | on SUMIT's hosted Payment Page | no |

`beginredirect` itself creates only a one-time payment. For Flow B this is
intentional: that first hosted checkout saves the card at SUMIT unless
`PreventSavingPaymentMethod` is set. The app never stores card data; it stores
only the SUMIT `OG-CustomerID` and the standing-order id returned later by
`/billing/recurring/charge/`.

### Checkout → hosted cycle-1 payment

The app creates a pending subscription/order, then opens a normal hosted checkout:

```ts
const intent = await provider.createPaymentIntent({
  amount: { amountMinor: 2990, currency: 'ILS' },
  userId: 'user_1',
  idempotencyKey: 'sub_abc',
  returnUrl: 'https://app/billing/return',
  description: 'Basic monthly',
  metadata: {
    orderId: 'sub_abc',
    customerEmail: 'buyer@example.com',
    // Optional: reuse an existing SUMIT customer instead of creating a new one.
    providerCustomerId: '2017349142',
    // Do not set preventSavingPaymentMethod for subscriptions.
  },
});
// redirect the browser to intent.redirectUrl
```

When `metadata.providerCustomerId` is present, the adapter sends
`Customer: { ID: <providerCustomerId> }` to SUMIT's hosted checkout. This reuses
the existing SUMIT customer while keeping the user on the normal hosted checkout
flow; the app still does not store card details.

### On return — what SUMIT appends, and the grant

On success SUMIT redirects to your return URL with `og-*` params. Parse them
case-insensitively with the helper:

```ts
import { parseSubscriptionReturn } from '@nehorai/payments-sumit';

const { paymentId, subscriptionId, customerId, paymentType, documentNumber } =
  parseSubscriptionReturn(searchParams);
// og-paymentid / og-externalidentifier / og-customerid / og-paymenttype / og-documentnumber
```

Then grant **cycle 1** through the same verify-on-return anchor as §3: call
`getPayment(paymentId)` and require `ValidPayment === true` (+ amount match) before
granting. `og-externalidentifier` echoes your `subscriptionId`;
`og-documentnumber` is the auto-issued invoice number.

After verification succeeds, create the standing order for the next cycle:

```ts
const created = await provider.createSubscription({
  amount: { amountMinor: 2990, currency: 'ILS' },
  userId: 'user_1',
  idempotencyKey: 'sub_abc',
  interval: 'monthly',
  providerCustomerId: customerId,
  startDate: '2026-07-28',
  externalIdentifier: 'sub_abc',
});
```

Use a future `Date_Start` (`startDate`) so SUMIT does not double-charge on signup.

### Renewals — auto-charge → webhook

Each subsequent cycle SUMIT auto-charges the standing order and fires the
Triggers+Views webhook. `SumitWebhookHandler.parseEvent` normalizes it:

- A payment carrying `RecurringCustomerItemIDs` (or `RecurringCustomerItemID` /
  `IsRecurring` / `Recurring`) is detected as **recurring**, so it normalizes to
  `subscription.renewed` (valid) or `subscription.payment_failed` (invalid),
  rather than the one-time `payment.succeeded` / `payment.failed`.
- A canceled flag (`Canceled` / `Cancelled` / `IsCanceled`) → `subscription.canceled`.

The renewal grant must NOT be gated on the subscription `status` (a renewal hits
an **already-active** subscription) — see §6b for the per-cycle idempotency model.

### Cancellation

Reuse the published `cancelSubscription` → `POST /billing/recurring/cancel/` with
the numeric `RecurringCustomerItemID` (passed as `providerSubscriptionId`) and the
owning `providerCustomerId` when available.

## 6b. The 3-layer grant model (recurring)

Every grant — first cycle and every renewal — is gated on a **live SUMIT
confirmation**, never on elapsed time. Three layers, defense-in-depth:

1. **Event-driven (webhook).** Renewal webhook arrives → verify against SUMIT
   (`getPayment` → `ValidPayment === true` + amount-anchor) → grant that cycle.
2. **Reconcile-on-read (the backbone).** Lazy: when a subscription's
   `nextChargeAt` has passed without a recorded cycle, query SUMIT **on read** and
   grant **iff** SUMIT confirms the charge. This covers any webhook that never
   arrived.
3. **Thin optional cron.** A light sweep for inactive users who don't trigger a
   read, doing the same confirm-then-grant.

**Per-cycle idempotency = the charge-id ledger doc, NOT the subscription
`status`.** Because a renewal lands on an already-`active` subscription, status is
useless as a guard. The idempotency key is the per-charge ledger row (one doc per
SUMIT charge id); a redelivered webhook + a reconcile-on-read pass converge on the
same doc and grant exactly once.

### Credits grant shape

One-time packs are purchased/admin credits: call `CreditsService.addCredits(...)`
or the repository's add-credit path so they increase `bonusCredits` and never
reset monthly.

Subscription cycles are monthly allowance reloads: do **not** call `addCredits`
for renewals, because that turns every cycle into permanent bonus credits. After
the charge-id ledger row is claimed, set the user's monthly `balance`,
`monthlyLimit`, `monthlyUsed = 0`, and `subscriptionExpiresAt = periodEnd`.
Park `monthlyResetAt` beyond `periodEnd + grace` so an automatic monthly reset
cannot mint a fresh cycle without a confirmed SUMIT charge. If the app still has
a legacy credits table, sync it from the plugin balance only for backward-
compatible UI reads; do not use it as the grant source of truth.

## 7c. Dynamic-but-type-safe tiers & the Pro plan

The `@nehorai/credits` tier set is now **config-owned**, not a closed union:

```ts
// packages/credits/src/core/types.ts
export type BuiltinTier = "free" | "basic" | "premium" | "unlimited";
export type SubscriptionTier = BuiltinTier | (string & {});
```

Adding a new tier is a **config-only** change (define it in the consuming app's
credits config) — **no plugin republish** required, while the builtin names stay
type-checked. Apps may map business plans (`basic`, `pro`, `enterprise`) onto
configured plugin tiers (`basic`, `premium`, custom tiers, etc.) while storing
the actual business plan id in the app subscription record.

**Subscription gating (app-side).** A plan is offered when the app catalog allows
it and SUMIT credentials are configured. Flow B does not need per-plan
`SUMIT_SUB_PAGE_URL_*` env vars.

**Naming convention:** subscriptions are named by **plan name** (Basic / Premium /
Pro); one-time packs are named by **quantity** (100 / 300 / 1,000 Credits).

## Setup required before subscriptions work in prod

Flow B depends on SUMIT API capability, not dashboard Payment Pages. Per SUMIT
org (test and prod separately):

1. Enable API access and recurring/standing-order capability.
2. Set `SUMIT_COMPANY_ID`, `SUMIT_API_KEY`, and `SUMIT_WEBHOOK_TOKEN`.
3. Configure the shared-token webhook URL in SUMIT Triggers+Views.
4. Run a live/sandbox check: hosted checkout returns `OG-CustomerID`, then
   `createSubscription` with future `Date_Start` creates the standing order
   without charging immediately.

Until these are done, one-time credit-pack checkout can work while subscription
renewals may fail to schedule.

## 7. Test org (sandbox, no real charges)

`help.sumit.co.il/he/articles/5840939`: org-switcher → "יצירת עסק חדש" (name must
contain "בדיקות") → install the free API module → connect a test terminal at
`app.sumit.co.il/developers/testterminal` (this **disconnects real card
processing** — that's why it must be a separate org) → mint key at
`/developers/keys/` → fill פרטי עסק (the מספר עוסק must be globally unique in
SUMIT). Test cards: `help.sumit.co.il/he/articles/5832877` (e.g. Visa
`4557430402321333`, exp `05/31`, CVV `098`).
