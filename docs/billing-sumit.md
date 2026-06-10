# SUMIT (UPAY) Billing Integration

`@nehorai/payments-sumit` adds **SUMIT** (credit-card clearing via **UPAY**, incl.
Apple Pay / Google Pay / Bit on the same link) as a provider adapter for the
`@nehorai/payments` plugin. It implements the standard provider contracts so an
application can clear payments through SUMIT exactly like Stripe or Cardcom.

> **Separation of concerns.** This adapter only talks to SUMIT and emits
> *normalized events*. Credits, plans, users, permissions and order state live
> in the **application's billing/domain layer** — never in the adapter. SUMIT is
> responsible for *billing*; the app is responsible for *entitlements*.

---

## 1. What is implemented

| Capability | Method | SUMIT endpoint | Notes |
|---|---|---|---|
| One-time hosted checkout | `createPaymentIntent` | `POST /billing/payments/beginredirect/` | Returns a hosted payment-page `redirectUrl`. PCI-safe; card data never touches us. |
| Payment status (verification) | `getPaymentIntentStatus` | `POST /billing/payments/get/` *(verify)* | Authoritative server-side check used to confirm unsigned webhooks. |
| Authorize / Capture | `authorize`, `capture` | `get` | SUMIT is single-phase; both resolve by querying the payment. |
| Void | `void` | — | Not supported via API (use the SUMIT dashboard). |
| Refund | `refund` | — | **Not yet implemented** (endpoint pending doc verification). |
| Create subscription | `createSubscription` | `beginredirect` + `Recurrence` *(verify)* | Monthly standing order via hosted page. |
| Cancel subscription | `cancelSubscription` | `POST /billing/recurring/cancel/` *(verify)* | |
| Get subscription | `getSubscription` | `POST /billing/recurring/get/` *(verify)* | |
| Webhook normalization | `SumitWebhookHandler.parseEvent` | n/a | Normalizes SUMIT trigger payloads → unified events. |

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
3. The adapter appends `?internal_order_id=ord_abc123` to `returnUrl` so the
   redirect back can be matched to the order even before the webhook arrives.
4. Complete the payment on the hosted page using SUMIT test-card details.
5. Confirm with `provider.getPaymentIntentStatus(result.providerIntentId)` →
   expect `captured`.

---

## 4. How to test the webhook

SUMIT has **no built-in payment webhook**. It is configured in the SUMIT UI via
**Triggers + Views** (install the *Triggers*, *API* and *View management*
modules):

1. Create a **View** over the payments/documents folder that exposes at least:
   `PaymentID` (or `ID`), `ValidPayment`, `Amount`, `Currency`, and — for
   subscriptions — `IsRecurring`/`RecurringID` and a `Canceled` flag.
2. Create a **Trigger** that fires on card create/update and POSTs (JSON) to:
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
const parsed = handler.parseEvent({ PaymentID: '1001', ValidPayment: true, Amount: 49, Currency: 'ILS' });
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
vary. The parser reads candidate keys defensively:

| Concept | Candidate fields read |
|---|---|
| Payment / document id | `PaymentID`, `ID`, `PaymentMethodID`, `DocumentID`, `RecurringID` |
| Success flag | `ValidPayment`, `Valid`, `Success`, `Paid` |
| Recurring flag | `IsRecurring`, `Recurring`, presence of `RecurringID` |
| Cancellation | `Canceled`, `Cancelled`, `IsCanceled` |
| Amount / currency | `Amount`/`Total`/`Sum`, `Currency` |
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

## 7. How monthly credit reload works

1. SUMIT bills the standing order each month and creates a new payment/document
   → the trigger fires → webhook arrives.
2. The adapter normalizes it to `subscription.renewed` (or
   `subscription.payment_failed`).
3. On `subscription.renewed`, the app marks the subscription `active`, advances
   `current_period_*`, and grants that month's credits (per the plan's
   `credits_reset_policy`: `add` / `reset` / `none`).
4. On `subscription.payment_failed`, the app marks the subscription `past_due`.
5. On `subscription.canceled`, the app marks it `canceled`.

---

## 8. What is NOT supported yet

- **Refunds** via API (endpoint pending verification against the live swagger).
- **`void`** (J5) — SUMIT is single-phase; cancel/refund from the dashboard.
- **Saved-card / setup intents** as a standalone flow.
- App-level billing tables, the `/api/billing/*` routes and credit-granting —
  these belong to the consuming application, not this plugin.
- Endpoints/field names marked *(verify)* must be confirmed against a SUMIT
  test org + the swagger before production use.

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
- API surface / mappers / **TO-VERIFY** endpoints: `packages/payments-sumit/src/sumit-types.ts`
- Factory + token verifier: `packages/payments-sumit/src/factory.ts`
- SUMIT swagger: <https://app.sumit.co.il/help/developers/swagger/index.html>
