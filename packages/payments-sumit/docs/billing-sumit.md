# Integrating `@nehorai/payments-sumit`

SUMIT (UPAY) hosted-redirect checkout for one-time purchases and subscriptions.
This is the integration recipe distilled from a full production-grade wiring +
live test-org E2E. The plugin speaks SUMIT; **credits/plans/entitlements/users
live in your app**, not here.

Reference implementation: `family-anniversary-games` (the "דור" app) —
`src/lib/server/payments/{sumit-config,sumit,verify-return,fulfil-sumit}.ts`.

## 1. The model (one business, many products)

A SUMIT account **is a legal business** (עוסק/חברה) that issues tax documents.
Rule: **one SUMIT account per legal entity — NOT one per product.** All your
products (e.g. Story Creator, podcasToYOU, דור) bill under the same business →
one set of books, one VAT report, one API account (CompanyID + APIKey), one UPAY.

Separate products in **your** system, not in SUMIT:
- `ExternalIdentifier` = your order id (UUID) — globally unique across all apps,
  no collision. Each app only looks up its own orders, so a foreign payment is
  simply ignored.
- Per-charge item `Description`/Name carries the product label (e.g. "דור — דאבל")
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

## 7b. Recurring monthly subscriptions (hosted, "Route A")

> ✅ The reference apps use **Route A**: a pre-built SUMIT Payment Page per plan.
> `beginredirect` remains the one-time checkout path; it does not create hosted
> recurring subscriptions.

| Route | How | Card collection | Needs a token? |
| --- | --- | --- | --- |
| **A — hosted Payment Page (primary)** | redirect to a per-plan **Payment Page** bound to a recurring product | on SUMIT's hosted page (PCI-safe) | **no** |
| B — server-to-server | `createSubscription` → `/billing/recurring/charge/` against a saved customer/token | none | usually **yes** (`SingleUseToken`) or a saved customer id |

> `beginredirect`'s `ChargeItem` itself has no recurring fields. Route A relies
> on a SUMIT-dashboard **Payment Page** (דף תשלום) bound to a recurring monthly
> product — created once per plan — plus the two **pure** URL helpers
> `buildSubscriptionPageUrl` / `parseSubscriptionReturn` (`subscription-page-url.ts`;
> no network, no credentials, no SDK).

### Checkout → redirect to the plan's Payment Page

The app holds one pre-built page base URL **per plan** (env-injected — see
"Setup required" below) and decorates it with binding params:

```ts
import { buildSubscriptionPageUrl } from '@nehorai/payments-sumit';

const url = buildSubscriptionPageUrl(pageBaseUrl /* per-plan, from env */, {
  userId: 'user_1',              // → customerexternalidentifier
  subscriptionId: 'sub_abc',     // → externalidentifier (echoed back on return)
  returnUrl: 'https://app/billing/return',
  fixedRecurrence: undefined,    // omit ⇒ OPEN-ENDED; a finite N ⇒ bounded (fixedrecurrence=N)
  customerName: '…',             // optional → name
  customerEmail: '…',            // optional → emailaddress
});
// redirect the browser to `url`
```

IN params written onto the page URL: `customerexternalidentifier`,
`externalidentifier`, the success-return URL (under
`SUCCESS_REDIRECT_QUERY_KEY`), and — only when bounded — `fixedrecurrence`, plus
optional `name` / `emailaddress` prefill.

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
the numeric `RecurringCustomerItemID` (passed as `providerSubscriptionId`).

> ⚠️ **`SUCCESS_REDIRECT_QUERY_KEY` is still a guess** (`'redirecturl'` in
> `subscription-page-url.ts`). The real query key the Payment Page uses for the
> success-return URL must be confirmed against a live page, then corrected and
> republished — see "Setup required before subscriptions work in prod" below.

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

**Per-plan subscription gating (app-side).** A plan is offered only if its page
URL env var is set — `isPlanPurchasable(planId)` checks the matching
`SUMIT_SUB_PAGE_URL_*`. `isSubscriptionsConfigured()` still requires at least
**basic + premium** to be configured before the subscriptions UI turns on. These
helpers live in the **consuming app**, not in this plugin.

**Naming convention:** subscriptions are named by **plan name** (Basic / Premium /
Pro); one-time packs are named by **quantity** (100 / 300 / 1,000 Credits).

## Setup required before subscriptions work in prod

Route A depends on dashboard objects + env that do **not** exist yet. Per SUMIT
org (test and prod separately):

1. Create **3 recurring monthly products**: Basic ₪29.90, Premium ₪79.90, Pro ₪199.
2. Create **3 Payment Pages** (דפי תשלום), one per product, and capture the real
   **page-URL format** for each.
3. Confirm the success-redirect **query-param name** the Payment Page expects, then
   fix `SUCCESS_REDIRECT_QUERY_KEY` in `subscription-page-url.ts` (currently the
   guess `'redirecturl'`) and **republish** the plugin.
4. Set the per-plan env vars in the app:
   `SUMIT_SUB_PAGE_URL_BASIC_MONTHLY`, `SUMIT_SUB_PAGE_URL_PREMIUM_MONTHLY`,
   `SUMIT_SUB_PAGE_URL_PRO_MONTHLY`.

Until these are done, one-time credit-pack checkout works but the subscription
plans stay hidden (gated by `isPlanPurchasable`).

## 7. Test org (sandbox, no real charges)

`help.sumit.co.il/he/articles/5840939`: org-switcher → "יצירת עסק חדש" (name must
contain "בדיקות") → install the free API module → connect a test terminal at
`app.sumit.co.il/developers/testterminal` (this **disconnects real card
processing** — that's why it must be a separate org) → mint key at
`/developers/keys/` → fill פרטי עסק (the מספר עוסק must be globally unique in
SUMIT). Test cards: `help.sumit.co.il/he/articles/5832877` (e.g. Visa
`4557430402321333`, exp `05/31`, CVV `098`).
