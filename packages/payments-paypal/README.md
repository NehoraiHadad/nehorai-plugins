# @nehorai/payments-paypal

PayPal (Orders v2 + Payments v2) payment-provider adapter for
[`@nehorai/payments`](../payments). Implements the same `IPaymentProvider` seam
as [`@nehorai/payments-sumit`](../payments-sumit), so the app consumes PayPal
through the identical interface.

Credits, plans, users and permissions are **not** handled here — that belongs to
the application's billing/domain layer.

## Thin slice implemented

| Capability                       | Endpoint (verified against developer.paypal.com)                      |
| -------------------------------- | --------------------------------------------------------------------- |
| OAuth2 access token (cached)     | `POST /v1/oauth2/token` — Basic auth, `grant_type=client_credentials` |
| `createPaymentIntent`            | `POST /v2/checkout/orders` (`intent: "CAPTURE"`)                       |
| `verifyPayment` (verify-on-return) | `GET /v2/checkout/orders/{id}` → `POST /v2/checkout/orders/{id}/capture` |
| `capture`                        | `POST /v2/checkout/orders/{id}/capture`                               |
| `getPaymentIntentStatus`         | `GET /v2/checkout/orders/{id}`                                        |
| `verifyWebhookSignature` (async) | `POST /v1/notifications/verify-webhook-signature`                     |
| webhook `parseEvent`             | normalizes `PAYMENT.CAPTURE.COMPLETED/DENIED/REFUNDED/REVERSED`        |
| `refund` (**real**, not a stub)  | `POST /v2/payments/captures/{captureId}/refund`                       |

## Subscriptions

Implements the optional `ISubscriptionProvider` seam (same as
[`@nehorai/payments-sumit`](../payments-sumit)), so `supportsRecurring` is
`true` and the core layer detects it via `'createSubscription' in provider`.

A PayPal subscription is priced by its **billing plan**, not by an amount on the
create call. Provisioning is three steps: create a **product**, create a
**plan** (price + monthly cadence) on it, then create a **subscription** against
the plan. The buyer approves via the returned `redirectUrl`; PayPal then emits
`BILLING.SUBSCRIPTION.ACTIVATED` and, for each cycle, `PAYMENT.SALE.COMPLETED`.

| Capability                          | Endpoint (verified against developer.paypal.com)                 |
| ----------------------------------- | ---------------------------------------------------------------- |
| `createProduct` (provisioning)      | `POST /v1/catalogs/products`                                     |
| `createPlan` (monthly regular cycle) | `POST /v1/billing/plans`                                        |
| `createSubscription` (interface)    | `POST /v1/billing/subscriptions` → id `I-...` + approval link    |
| `cancelSubscription` (interface)    | `POST /v1/billing/subscriptions/{id}/cancel` (immediate, `204`)  |
| `getSubscription`                   | `GET /v1/billing/subscriptions/{id}`                            |
| `suspendSubscription`               | `POST /v1/billing/subscriptions/{id}/suspend` (`204`)           |
| `activateSubscription`              | `POST /v1/billing/subscriptions/{id}/activate` (`204`)          |
| `reviseSubscription` (plan change)  | `POST /v1/billing/subscriptions/{id}/revise` (returns approval link when re-approval is needed) |

`createSubscription` takes the core `CreateSubscriptionParams` **plus**
`PaypalCreateSubscriptionExtra` (`paypalPlanId`, `customId`, `cancelUrl?`,
`brandName?`, `subscriberEmail?`). The core `amount` is accepted for
interface-compatibility but **ignored** — the plan drives the price. A present
`redirectUrl` on the result means **buyer approval is still required** (status
`APPROVAL_PENDING`); only grant on `ACTIVE`.

`cancelSubscription` is **immediate** at the PayPal API level — `atPeriodEnd` is
honoured by the **app's** entitlement logic (keep access until
`currentPeriodEnd`), not by PayPal.

### Subscription webhook events

Normalized into the shared vocabulary (names reused verbatim from
payments-sumit so app handler logic is shared):

| PayPal `event_type`                   | Normalized event                | `resource` id source                                    |
| ------------------------------------- | ------------------------------- | ------------------------------------------------------- |
| `BILLING.SUBSCRIPTION.ACTIVATED`      | `subscription.activated`        | `resource.id` = subscription id (`I-...`)               |
| `BILLING.SUBSCRIPTION.CANCELLED`      | `subscription.canceled`         | `resource.id` = subscription id                         |
| `BILLING.SUBSCRIPTION.SUSPENDED`      | `subscription.suspended`        | `resource.id` = subscription id                         |
| `BILLING.SUBSCRIPTION.EXPIRED`        | `subscription.expired`          | `resource.id` = subscription id                         |
| `BILLING.SUBSCRIPTION.PAYMENT.FAILED` | `subscription.payment_failed`   | `resource.id` = subscription id                         |
| `PAYMENT.SALE.COMPLETED`              | `subscription.renewed`          | `resource.id` = sale/charge id; **subscription id in `resource.billing_agreement_id`** |

For the recurring charge (`PAYMENT.SALE.COMPLETED`), `providerTransactionId` is
the **sale id** (the per-cycle idempotency guard key) and the owning
subscription id is read from `rawPayload.resource.billing_agreement_id` — the
same way the one-time path reads `custom_id` from `rawPayload`. That event uses
the deprecated Payments v1 money shape (`amount.total` + `amount.currency`),
which `parseEvent` handles alongside the v2 capture shape.

## Configuration

Env-driven, zod-validated. No defaults for secrets — fails closed if absent.

| Env var                | Purpose                                          |
| ---------------------- | ------------------------------------------------ |
| `PAYPAL_CLIENT_ID`     | REST app client id (required)                    |
| `PAYPAL_CLIENT_SECRET` | REST app client secret (required)                |
| `PAYPAL_ENV`           | `sandbox` (default) or `live` — selects base URL |
| `PAYPAL_WEBHOOK_ID`    | Webhook id (required to verify webhooks)         |

```typescript
import { createPaymentServices } from '@nehorai/payments';
import { addPaypalProvider, paypalConfigFromEnv } from '@nehorai/payments-paypal';

const services = createPaymentServices({ providers: new Map() });
addPaypalProvider(services, paypalConfigFromEnv());
```

## Money handling

PayPal amounts are decimal strings (`amount.value` + `currency_code`). This
adapter converts to/from integer minor units, honouring PayPal's **zero-decimal**
currencies (`HUF`, `JPY`, `TWD`) — e.g. `JPY 100` ⇄ `"100"`, `USD 4900` ⇄
`"49.00"`. Note PayPal treats HUF/TWD as zero-decimal even though ISO 4217 does
not.

## Webhook verification (important)

PayPal webhook authenticity requires an **async postback** with five
transmission headers plus the webhook id, which the synchronous
`IPaymentProvider.validateWebhookSignature(payload, signature)` cannot express.
That sync method therefore **fails closed** (always returns `false`); the
receiving route must call the async `PaypalProvider.verifyWebhookSignature({...})`
with the incoming `paypal-*` headers before trusting an event.

## Status

One-time checkout **and** subscriptions are unit-tested with `fetch` mocked.
**Live sandbox E2E is pending real credentials** and is the remaining step
before production use — in particular, confirm that `PAYMENT.SALE.COMPLETED`
renewal events carry `resource.billing_agreement_id` on the live account (PayPal
has historically dropped this field on some accounts; the app should keep
`custom_id`/`GET subscription` as a fallback to resolve the owning subscription).
