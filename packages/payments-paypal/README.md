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

Unit-tested with `fetch` mocked. **Live sandbox E2E is pending real credentials**
and is the remaining step before production use.
