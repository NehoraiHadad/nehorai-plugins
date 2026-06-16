# SUMIT (UPAY) Billing Integration

`@nehorai/payments-sumit` adds **SUMIT** (credit-card clearing via **UPAY**, incl.
Apple Pay / Google Pay / Bit on the same link) as a provider adapter for the
`@nehorai/payments` plugin. It implements the standard provider contracts so an
application can clear payments through SUMIT exactly like Stripe or Cardcom.

> **Separation of concerns.** This adapter only talks to SUMIT and emits
> *normalized events*. Credits, plans, users, permissions and order state live
> in the **application's billing/domain layer** — never in the adapter. SUMIT is
> responsible for *billing*; the app is responsible for *entitlements*.

> **Source of truth.** Endpoints, field names and enums below were verified
> against the live OpenAPI spec: `https://api.sumit.co.il/swagger/v1/swagger.json`
> (UI: <https://app.sumit.co.il/help/developers/swagger/index.html>). The one
> item still to confirm against a real test org is the **webhook payload shape**,
> because it depends on the View you configure (see §5).

---

## 1. What is implemented

| Capability | Method | SUMIT endpoint | Notes |
|---|---|---|---|
| One-time hosted checkout | `createPaymentIntent` | `POST /billing/payments/beginredirect/` | Returns `Data.RedirectURL` (hosted page). PCI-safe; card data never touches us. |
| Payment status (verification) | `getPaymentIntentStatus` | `POST /billing/payments/get/` | Reads `Data.Payment.ValidPayment`. Authoritative check for unsigned webhooks. |
| Authorize / Capture | `authorize`, `capture` | `get` | SUMIT is single-phase; both resolve by querying the payment. |
| Void | `void` | — | Not supported via API (use the SUMIT dashboard). |
| Refund | `refund` | — | Not supported via API (issue from the SUMIT dashboard). |
| Hosted recurring (primary) | `buildSubscriptionPageUrl` / `parseSubscriptionReturn` | Payment Page (דף תשלום) | **Pure URL helpers** (no network). Redirect to a per-plan Payment Page bound to a recurring product; parse `og-*` on return. See §7. |
| Create subscription (server-to-server) | `createSubscription` | `POST /billing/recurring/charge/` | Charges a saved card; **requires `paymentMethodToken`** (see §7). Secondary path. |
| Cancel subscription | `cancelSubscription` | `POST /billing/recurring/cancel/` | By numeric `RecurringCustomerItemID`. |
| Webhook normalization | `SumitWebhookHandler.parseEvent` | n/a | Normalizes SUMIT trigger payloads → unified events. |

**Authentication.** Every request body carries
`Credentials: { CompanyID, APIKey }`. All calls are server-side `POST` JSON to
`https://api.sumit.co.il`. The response envelope is
`{ Status, UserErrorMessage, TechnicalErrorDetails, Data }` where `Status` is
`Success` (0) / `BusinessError` (1) / `TechnicalError` (2) — serialized as either
the number or the name, both handled by `isSumitSuccess`.

**Currency / Language are enums.** Currency: `ILS=0`, `USD=1`, `EUR=2` (the
adapter passes the ISO name, which matches the enum name). `Language` is omitted
(defaults to Hebrew) — the literal `'he'` is **not** a valid enum value.

**The live catalog is ILS (₪).** SUMIT is an Israeli processor, so every product
is priced in shekels; `USD`/`EUR` remain in the type union
(`SUMIT_SUPPORTED_CURRENCIES = ['ILS', 'USD', 'EUR']`) only as a legacy option no
live product uses. Prices live in the **app's** `plans.ts` / `products.ts`:
one-time packs **100 / 300 / 1,000 Credits** at **₪35 / ₪90 / ₪250**;
subscriptions **Basic / Premium / Pro** at **₪29.90 / ₪79.90 / ₪199** per month.
`operationCosts` and per-tier `monthlyLimit` are runtime-editable via the app's
Firestore admin config; only the prices live in code.

**Unified events emitted** (`SumitWebhookHandler`):
`payment.succeeded`, `payment.failed`, `subscription.renewed`,
`subscription.payment_failed`, `subscription.canceled`, `card.updated`.

### Endpoints exposed by the host application (not by this package)

The Next.js handler factories in `@nehorai/payments-nextjs` mount these — the
app owns the routes:

- `POST /api/billing/checkout` → calls `provider.createPaymentIntent(...)` (or
  `createSubscription`) and returns `{ checkoutUrl }`.
- `POST /api/billing/sumit/webhook` → verifies the URL token, calls
  `handler.parseEvent(...)`, dedupes via `webhook_events`, then updates the
  order and grants credits.

---

## 2. Required environment variables

Test and production are **fully separated** — only the injected config differs;
there is no code branching.

| Variable | Purpose |
|---|---|
| `SUMIT_COMPANY_ID_TEST` / `SUMIT_COMPANY_ID_PROD` | SUMIT organization id (number). |
| `SUMIT_API_KEY_TEST` / `SUMIT_API_KEY_PROD` | Private API key (server-side only). |
| `SUMIT_WEBHOOK_TOKEN_TEST` / `SUMIT_WEBHOOK_TOKEN_PROD` | Shared secret placed in the webhook URL (SUMIT has no HMAC). |
| `SUMIT_BASE_URL_TEST` / `SUMIT_BASE_URL_PROD` | Optional API base override (defaults to `https://api.sumit.co.il`). |

```ts
import { createPaymentServices } from '@nehorai/payments';
import { addSumitProvider } from '@nehorai/payments-sumit';

const services = createPaymentServices({ providers: new Map() });

addSumitProvider(services, {
  companyId: Number(process.env.SUMIT_COMPANY_ID_TEST),
  apiKey: process.env.SUMIT_API_KEY_TEST!,
  webhookToken: process.env.SUMIT_WEBHOOK_TOKEN_TEST,
  baseUrl: process.env.SUMIT_BASE_URL_TEST, // optional
});
```

> API keys are **server-side only** — never ship them to the client. All SUMIT
> calls are made from the server. Use HTTPS everywhere.

---

## 3. How to run a test payment (one-time)

1. Register the provider with **test** credentials (above).
2. Create a checkout:
   ```ts
   const provider = services.providers.get('sumit');
   const result = await provider.createPaymentIntent({
     amount: { amountMinor: 4900, currency: 'ILS' }, // 49.00 ₪
     userId: 'user_123',
     idempotencyKey: 'ord_abc123',         // your internal order id
     description: 'Story Creator – Monthly',
     returnUrl: 'https://app.example.com/billing/return',
     metadata: { orderId: 'ord_abc123', customerEmail: 'buyer@example.com' },
   });
   // result.redirectUrl → send the customer here (or embed in an iframe)
   ```
3. The internal order id is sent in SUMIT's `ExternalIdentifier` field (echoed
   back on the created payment) **and** appended as `?internal_order_id=ord_abc123`
   to `returnUrl`, so both the redirect leg and the webhook can be matched back.
4. Complete the payment on the hosted page using SUMIT test-card details.
5. After the webhook delivers the SUMIT `PaymentID`, confirm with
   `provider.getPaymentIntentStatus(paymentId)` → expect `captured`.

---

## 4. How to test the webhook

SUMIT has **no built-in payment webhook**. It is configured in the SUMIT UI via
**Triggers + Views** (install the *Triggers*, *API* and *View management*
modules):

1. Create a **View** over the payments folder exposing at least: `ID`,
   `ValidPayment`, `Amount`, `Currency`, and — for subscriptions —
   `RecurringCustomerItemIDs` (and a cancellation indicator).
2. Create a **Trigger** that fires on payment create/update and POSTs (JSON) to:
   ```
   https://app.example.com/api/billing/sumit/webhook?token=<SUMIT_WEBHOOK_TOKEN>
   ```
3. The application route:
   - reads the `token` query param and verifies it (`verifySumitToken` /
     `provider.validateWebhookSignature(rawBody, token)`),
   - calls `handler.parseEvent(payload)`,
   - **dedupes** on `webhook_events (provider, provider_event_id)` using the
     event's stable `eventId`,
   - calls `getPaymentIntentStatus` to confirm before any credit change,
   - returns `200` only after the event is persisted.

Local smoke test without SUMIT:
```ts
const handler = services.webhookHandlers.get('sumit');
const parsed = handler.parseEvent({ ID: 1001, ValidPayment: true, Amount: 49, Currency: 'ILS' });
// parsed.event.eventType === 'payment.succeeded'
// parsed.event.eventId   === '1001:payment.succeeded'  (stable → idempotent)
```

### Security model for the unsigned webhook
- **URL token** (required) — constant-time compared to the configured secret.
- **Supplementary API check** — never grant credits on the webhook alone; call
  `getPaymentIntentStatus`/`reconcile` to confirm with SUMIT.
- **Optional IP allowlist** at the edge as defense-in-depth.
- Rate-limit the checkout and webhook routes. Store raw payloads
  (`webhook_events.raw_payload`) for debugging.

---

## 5. SUMIT webhook payload

Because the payload is defined by the **View** you configure, exact field names
vary. The parser reads candidate keys defensively, aligned with the verified
`Payment` object (`ID`, `ValidPayment`, `Amount`, `Currency`,
`RecurringCustomerItemIDs`, `StatusDescription`):

| Concept | Candidate fields read |
|---|---|
| Payment / document id | `PaymentID`, `ID`, `PaymentMethodID`, `DocumentID`, `RecurringCustomerItemID` |
| Success flag | `ValidPayment`, `Valid`, `Success`, `Paid` |
| Recurring flag | `IsRecurring`, `Recurring`, presence of `RecurringCustomerItemIDs`/`RecurringCustomerItemID` |
| Cancellation | `Canceled`, `Cancelled`, `IsCanceled` |
| Amount / currency | `Amount`/`Total`/`Sum`, `Currency` |
| Error text | `StatusDescription`, `ErrorMessage`, `UserErrorMessage` |
| Explicit event hint | `EventType`, `event` |

> **Action item:** capture and paste a *real* test-org payload here once test
> credentials are available, then tighten the candidate-field lists if needed.

---

## 6. How credit granting works (application side)

Credits are **not** granted by the adapter. The flow:

1. Webhook arrives → token verified → `parseEvent` → dedupe on stable `eventId`.
2. Confirm with `getPaymentIntentStatus`.
3. On `payment.succeeded`, the app:
   - marks the matched order `paid`,
   - calls the existing `@nehorai/credits` service to grant credits, scoped by
     `product_id`, writing a `credit_ledger` row.
4. Idempotency guarantees the same logical event never grants twice, because the
   `webhook_events (provider, provider_event_id)` row already exists on redelivery.

---

## 7. Subscriptions & monthly credit reload

There are two ways to start a recurring standing order. **Route A (hosted) is the
primary path** the app uses; Route B (server-to-server) remains available.

| Route | How | Card collection | Token? |
|---|---|---|---|
| **A — hosted (primary)** | redirect to a per-plan **Payment Page** bound to a recurring product | on SUMIT's hosted page (PCI-safe) | **no** |
| B — server-to-server | `createSubscription` → `/billing/recurring/charge/` | none (charges a saved token) | **yes** |

> ⚠️ **Corrected assumption.** The hosted recurring path is **NOT** `beginredirect`
> — its `ChargeItem` has no recurring fields, so it can only create a one-off
> charge. There is **no** `createHostedSubscription` method. Route A uses a
> SUMIT-dashboard **Payment Page** (דף תשלום) bound to a recurring monthly
> **product**, plus two **pure** URL helpers in the plugin.

### Route A — hosted Payment Page

`subscription-page-url.ts` exports two pure helpers (no network, no credentials):

1. **Checkout:** `buildSubscriptionPageUrl(pageBaseUrl, { userId, subscriptionId,
   returnUrl, fixedRecurrence?, customerName?, customerEmail? })` decorates the
   plan's pre-built page URL with binding params (`customerexternalidentifier`
   ← `userId`, `externalidentifier` ← `subscriptionId`, the success-return URL
   under `SUCCESS_REDIRECT_QUERY_KEY`, and — only when bounded —
   `fixedrecurrence`). Redirect the browser there. `pageBaseUrl` is **env-injected
   per plan** (see "Setup required" below).
2. **On return:** SUMIT appends `og-paymentid`, `og-externalidentifier`,
   `og-customerid`, `og-paymenttype`, `og-documentnumber`. Parse them
   case-insensitively with `parseSubscriptionReturn(query)`. Grant **cycle 1**
   via the verify-on-return anchor (`getPayment` → `ValidPayment === true` +
   amount match); `og-externalidentifier` echoes your `subscriptionId`,
   `og-documentnumber` is the auto-issued invoice number.

> ⚠️ `SUCCESS_REDIRECT_QUERY_KEY` is currently the guess `'redirecturl'` and must
> be confirmed against a live Payment Page, then corrected and republished.

### Route B — server-to-server `createSubscription`
SUMIT's recurring API (`/billing/recurring/charge/`) cannot collect card details,
so a card **token** is required first:

1. Obtain a single-use token via the **SUMIT Payments JS API** in the browser
   (card data goes straight to SUMIT, never to us), *or* reuse a payment method
   saved during a prior hosted checkout.
2. Call `createSubscription({ amount, userId, idempotencyKey, paymentMethodToken, recurrenceCount? })`.
   The adapter posts a `ChargeRecurringItem` with `Duration_Months: 1` and
   returns the created standing order's `RecurringCustomerItemID` as
   `providerSubscriptionId`.

Either route: cancel with `cancelSubscription({ providerSubscriptionId })`
(numeric `RecurringCustomerItemID` → `POST /billing/recurring/cancel/`).

### Monthly reload — the 3-layer grant model
Every grant (cycle 1 and every renewal) is gated on a **live SUMIT confirmation**,
never on elapsed time. Three layers:

1. **Event-driven (webhook).** SUMIT auto-charges the standing order each cycle →
   trigger fires → webhook. `parseEvent` normalizes it to `subscription.renewed`
   (or `subscription.payment_failed`); recurring is detected via
   `RecurringCustomerItemIDs` on the payload. The app verifies against SUMIT
   (`getPayment` → `ValidPayment === true` + amount-anchor) before granting.
2. **Reconcile-on-read (the backbone).** Lazy: when a subscription's
   `nextChargeAt` has passed without a recorded cycle, the app queries SUMIT on
   read and grants **iff** confirmed — covering any webhook that never arrived.
3. **Thin optional cron.** A light sweep for inactive users, same confirm-then-grant.

**Per-cycle idempotency = the charge-id ledger doc, NOT the subscription
`status`.** A renewal lands on an already-`active` subscription, so `status` is
useless as a guard; the idempotency key is the per-charge ledger row (one doc per
SUMIT charge id). On `subscription.payment_failed` the app sets `past_due`; on
`subscription.canceled`, `canceled`.

### Plans, tiers & the new Pro plan
The `@nehorai/credits` tier set is **config-owned**:
`SubscriptionTier = BuiltinTier | (string & {})` where
`BuiltinTier = "free" | "basic" | "premium" | "unlimited"`. Adding a tier is
config-only — **no plugin republish**. A 3rd plan **`pro-monthly`** (tier `pro`,
1000 credits/cycle, ₪199) shipped alongside Basic/Premium. The app gates each plan
**per-plan** via `isPlanPurchasable(planId)` (a plan shows only if its
`SUMIT_SUB_PAGE_URL_*` env var is set); `isSubscriptionsConfigured()` still
requires basic + premium. (These helpers live in the consuming app, not this
package.)

### Setup required before subscriptions work in prod
Route A depends on dashboard objects + env that do not exist yet. Per SUMIT org
(test and prod separately): (1) create **3 recurring monthly products** — Basic
₪29.90 / Premium ₪79.90 / Pro ₪199; (2) create **3 Payment Pages**, capture each
real page-URL format; (3) confirm the success-redirect query-param name and fix
`SUCCESS_REDIRECT_QUERY_KEY` (currently `'redirecturl'`), then republish; (4) set
`SUMIT_SUB_PAGE_URL_BASIC_MONTHLY` / `_PREMIUM_MONTHLY` / `_PRO_MONTHLY`.

---

## 8. What is NOT supported yet

- **Refunds** and **`void`** via API — issue them from the SUMIT dashboard.
- **Saved-card / setup intents** as a standalone flow (tokenize via the SUMIT
  Payments JS API instead).
- App-level billing tables, the `/api/billing/*` routes and credit-granting —
  these belong to the consuming application, not this plugin.
- The exact **webhook payload field names** (View-dependent) — confirm against a
  test org and tighten §5 if needed.

---

## 9. Moving from test to production

1. Create a **separate** Production API key in SUMIT (keep it apart from test).
2. Inject the `*_PROD` env vars; ensure **UPAY** is active on the org.
3. Switch from the test terminal to the live terminal in SUMIT.
4. Run one small **real** payment and verify end-to-end:
   - payment cleared,
   - invoice/receipt generated,
   - webhook received and token-verified,
   - order updated to `paid`,
   - credits added,
   - **no duplicates** (redeliver the webhook; confirm dedupe).
5. Only then open to customers.

---

## Reference

- Provider class: `packages/payments-sumit/src/sumit-provider.ts`
- Webhook handler: `packages/payments-sumit/src/sumit-webhook-handler.ts`
- API surface / mappers / enums: `packages/payments-sumit/src/sumit-types.ts`
- Factory + token verifier: `packages/payments-sumit/src/factory.ts`
- SUMIT OpenAPI spec: <https://api.sumit.co.il/swagger/v1/swagger.json>
