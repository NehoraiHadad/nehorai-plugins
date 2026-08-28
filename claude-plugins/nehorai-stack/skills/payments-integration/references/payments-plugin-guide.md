# Payments Plugin System — Developer Guide

This guide explains the `@nehorai/payments` plugin family in this monorepo: what
the base plugin contains, how it decomposes into a **BASE plugin plus one plugin
per provider**, and how the pieces fit together end to end. It is written from
the actual source — every type and function named below is real and the relevant
`path:line` references are included.

> **Separation of concerns (the one rule that explains everything).** The base
> plugin defines *contracts* and optional *orchestration*. Each provider plugin
> is a *thin adapter* that talks to one provider's API and emits *normalized
> events*. Neither layer knows anything about your products, plans, credits or
> users — that lives in your application's billing/domain layer (the separate
> `@nehorai/credits` package is one example consumer). The adapter does
> *billing*; the app does *entitlements*.

---

## 1. Overview / mental model

```
                          ┌─────────────────────────────────────────────┐
                          │  @nehorai/payments  (BASE plugin)            │
   your app  ───────────► │  - contracts: IPaymentProvider /            │
   (billing service,      │    IWebhookHandler / ISubscriptionProvider  │
    Story Creator, etc.)  │  - normalized types (PaymentAmount,         │
                          │    TransactionStatus state machine / J5)    │
                          │  - PaymentServices registry (two Maps)      │
                          │  - OPTIONAL: orchestrator / routing /       │
                          │    circuit breaker                          │
                          └───────────────┬─────────────────────────────┘
                                          │ providers.get('sumit')
                                          ▼
                          ┌─────────────────────────────────────────────┐
                          │  PROVIDER plugin (thin adapter)             │
                          │  payments-stripe / payments-il (hyp,        │
                          │  cardcom) / payments-sumit                  │
                          │  implements IPaymentProvider (+ webhook      │
                          │  handler, + maybe ISubscriptionProvider)    │
                          └───────────────┬─────────────────────────────┘
                                          │ HTTPS (SDK or fetch)
                                          ▼
                                  Provider API (Stripe / SUMIT / …)


  Webhook leg:

   provider  ──POST──►  app route  ──►  webhookHandlers.get(provider)
                          │                    .parseEvent(rawPayload)
                          │                          │
                          │                          ▼
                          │              ParsedWebhookEvent (normalized:
                          │              eventType, providerTransactionId,
                          │              amountMinor, currency, newStatus)
                          ▼                          │
                  dedupe on                          ▼
            webhook_events(provider,        app domain (e.g. @nehorai/credits)
            provider_event_id) unique  ───► mark order paid + grant credits
```

The key split to internalize:

- **BASE plugin** = the interfaces every adapter must satisfy, a stable
  normalized type system, a provider registry, and a set of **optional**
  enterprise services (orchestrator, routing engine, circuit breaker).
- **PROVIDER plugin** = a small package that implements those interfaces for one
  vendor and exposes an `addXProvider(services, config)` factory that registers
  itself into the registry.

You can use a provider adapter *directly* (just call its methods) without ever
touching the orchestrator. That matters for section 9.

---

## 2. The base plugin (`@nehorai/payments`)

Source: `packages/payments/src/`. The public surface is `index.ts`.

### 2.1 The provider contracts

Three interfaces define what an adapter can do.

**`IPaymentProvider`** — `providers/interfaces/payment-provider.interface.ts:114`.
The core contract every adapter implements. Properties: `name`,
`supportedCurrencies`, `supportsRecurring`, `supportsSplitPayments`. Methods
cover the full Two-Phase Commit (J5) flow plus tokenization, customers, health
and queries:

- `createPaymentIntent(params)` → `PaymentIntentResult`
- `authorize(params)`, `capture(params)`, `void(params)` (J5)
- `refund(params)`
- `createSetupIntent`, `savePaymentMethod`, `deletePaymentMethod` (tokenization)
- `createCustomer`, `getOrCreateCustomer`
- `getHealth()`, `validateWebhookSignature(payload, signature)`,
  `getPaymentIntentStatus(providerIntentId)`

**`IWebhookHandler`** — `providers/interfaces/webhook-handler.interface.ts:83`.
The contract for turning a raw provider webhook into a normalized event:

- `parseEvent(rawPayload)` → `ParseWebhookResult` (carries a `ParsedWebhookEvent`)
- `processEvent(event)`, `canHandle(eventType)`
- `reconcile(transactionId, providerTransactionId)` → `ReconciliationResult`
- `mapEventType(...)`, `mapStatus(...)`

The normalized `ParsedWebhookEvent` (line 22) is the heart of the abstraction:
`provider`, `eventId`, `eventType`, `providerTransactionId`, `amountMinor`,
`currency`, `newStatus`, `error`, `timestamp`, `rawPayload`. Your app reads these
fields and never has to know a provider's wire format.

**`ISubscriptionProvider`** — `providers/interfaces/subscription-provider.interface.ts:35`.
An **optional, separate** capability so one-time-only providers aren't forced to
implement recurring billing. It adds `createSubscription(params)` and
`cancelSubscription(params)`. Capability detection is duck-typed at runtime:

```ts
if ('createSubscription' in provider) { /* supports subscriptions */ }
```

(SUMIT and Stripe both implement it; the IL adapters do not.)

There is also **`IRoutingEngine`** —
`providers/interfaces/routing-engine.interface.ts:75` — the contract for the
optional routing service (see 2.4).

### 2.2 The normalized type system

Source: `types/payment-types.ts`, `types/state-machine.ts`, `types/webhook-types.ts`.

- **`PaymentAmount`** (`payment-types.ts:56`) — money is always
  `{ amountMinor, currency }` in **minor units** (cents/agorot) with an ISO-4217
  currency string. Adapters convert to/from the provider's representation (SUMIT,
  for example, works in major units, so its adapter does `amountMinor / 100`).
- **`TransactionStatus`** (`state-machine.ts:34`) — a strict 10-state machine:
  `created → pending_authorization → authorized → capturing → captured`, with
  `voided`, `failed`, `expired`, `partially_refunded`, `fully_refunded`. This is
  the **J5 / two-phase-commit** model. The file ships the transition rules
  (`VALID_TRANSITIONS`), terminal/success sets (`TERMINAL_STATES`,
  `SUCCESS_STATES`), and pure helpers exported from `index.ts`: `canTransition`,
  `getNextStatus`, `attemptTransition`, `isTerminalState`, `isSuccessState`,
  `canCapture`, `canVoid`, `canRefund`, plus auth-expiry helpers
  (`calculateCaptureDeadline`, `isAuthorizationExpired`, default hold = 7 days).
- **Operation params/results** — `CreatePaymentIntentParams`/`PaymentIntentResult`,
  `Authorize*`, `Capture*`, `Void*`, `Refund*`, and the subscription types
  (`CreateSubscriptionParams`, `SubscriptionResult`, `SubscriptionStatus =
  'active' | 'past_due' | 'canceled' | 'paused'`, `SubscriptionInterval =
  'monthly'`).
- **Webhook types** (`webhook-types.ts`) — `WebhookEvent`, `WebhookProcessingResult`,
  `WebhookAction`, and `ReconciliationResult` (which models the
  redirect-vs-webhook race with a `source: 'redirect' | 'webhook' |
  'provider_query'`).

### 2.3 The `PaymentServices` registry

Source: `factory.ts`.

`createPaymentServices(options)` (`factory.ts:103`) wires up a `PaymentServices`
object (`factory.ts:75`). The two fields that matter most are the **registries**:

- `providers: Map<PaymentProvider, IPaymentProvider>`
- `webhookHandlers: Map<PaymentProvider, IWebhookHandler>`

(`PaymentProvider` is just `string` — `payment-types.ts:15` — so the system is
open to any provider name.) The factory also constructs the three optional
services (`orchestrator`, `routingEngine`, `circuitBreaker`) and stores `config`.
It throws if `providers.size === 0`.

Two ways to add providers:

- **Mutating factories** (`addStripeProvider`, `addSumitProvider`,
  `addIsraeliProviders`) call `services.providers.set(name, provider)` in place —
  the common path.
- **`registerProvider(services, name, provider, webhookHandler?)`**
  (`factory.ts:151`) returns a *new* immutable `PaymentServices` with the provider
  added (and re-creates the orchestrator around the new map).

There is also a singleton convenience pair: `getPaymentServices(config?)` /
`resetPaymentServices()` (`factory.ts:189`).

### 2.4 The OPTIONAL services

These exist for multi-provider, enterprise-grade resilience. They are created by
the factory but **you are free to ignore them** and just call a provider directly.

- **`PaymentOrchestrator`** (`services/payment-orchestrator.ts:98`) — coordinates
  routing + provider call + circuit breaker. `initiatePayment` routes to a
  provider, checks the circuit breaker, calls `createPaymentIntent`, records
  success/failure, and on failure walks `routing.fallbackProviders` via
  `tryFailover` (line 269). Also `confirmPayment` (authorize) and `capturePayment`.
- **`RoutingEngine`** (`services/routing-engine.ts`) — picks a provider from
  injected `RoutingRules`: `CardBinRule` (BIN-range → preferred provider),
  `ProviderPriorityRule` (priority, max fee, currency/recurring support),
  `CurrencyRule`. Returns a `RoutingDecision` with `fallbackProviders`.
- **`CircuitBreaker`** (`services/circuit-breaker.ts:70`) — closed/open/half-open
  states per provider, default `failureThreshold: 5`, `resetTimeoutMs: 60000`.
  Storage is pluggable via `ICircuitBreakerStorage`
  (`circuit-breaker-storage.interface.ts`); default is
  `InMemoryCircuitBreakerStorage` (`in-memory-storage.ts`), and
  `@nehorai/payments-drizzle` ships a DB-backed `DrizzleCircuitBreakerStorage`.

### 2.5 Signature verification utilities

Source: `utils/signature-verification.ts`. A small registry pattern:

- `verifyWebhookSignature(params)` (line 179) — looks up a per-provider verifier
  in a registry; **falls back to plain HMAC-SHA256** if none is registered.
- Built-in strategies: `verifyStripeStyleSignature` (the `t=…,v1=…` scheme with
  timestamp tolerance), `verifySortedFieldsHmacSignature`, `verifyHmacSha256Signature`.
- `registerSignatureVerifier(provider, verifier)` / `getSignatureVerifier(provider)`
  — how a provider plugin installs its own check (SUMIT uses this for its URL-token
  scheme).
- `getSignatureHeaderName(provider)` (line 201) — returns `x-<provider>-signature`
  by default; used by the generic Next.js webhook route to find the signature
  header. (Note: this is header-based and doesn't natively fit SUMIT's URL token —
  see section 7.)

ID utilities live in `utils/idempotency.ts` (`generateInternalPaymentId`,
`generateIdempotencyKey`, `generateDeterministicKey`, validators).

### 2.6 Repository interfaces (database-agnostic)

Source: `repository/interfaces/`. The base plugin **defines** repository
contracts but ships no real database. The aggregate is `IPaymentRepositories`
(`interfaces/index.ts:108`):

```ts
interface IPaymentRepositories {
  transactions:   ITransactionRepository
  paymentMethods: IPaymentMethodRepository
  webhookEvents:  IWebhookEventRepository
  auditLog:       IAuditLogRepository
  providerHealth: IProviderHealthRepository
}
```

Two implementations exist: an in-memory reference
(`repository/memory/in-memory-transaction.ts`, exported as
`InMemoryTransactionRepository`) for tests, and the real Postgres one in
`@nehorai/payments-drizzle` (section 6). The app supplies whichever it wants.

---

## 3. A provider plugin

Every provider plugin has the same anatomy:

1. A **provider class** implementing `IPaymentProvider` (and optionally
   `ISubscriptionProvider`).
2. A **webhook handler** implementing `IWebhookHandler`.
3. A **types/config** module (provider-specific shapes, enums, mappers).
4. An **`addXProvider(services, config)` factory** that registers the class and
   handler into the registry Maps — and, where needed, installs a signature
   verifier.

The factory's only contract with the base plugin is a structural
`ProviderRegistry` = `{ providers: Map, webhookHandlers: Map }`, which
`PaymentServices` satisfies.

### 3.1 Example: Stripe (SDK + HMAC webhook)

Files: `packages/payments-stripe/src/` → `stripe-provider.ts`,
`stripe-webhook-handler.ts`, `stripe-types.ts`, `index.ts`.

- `StripeProvider` (`stripe-provider.ts:60`) wraps the official `stripe` SDK.
  `createPaymentIntent` calls `this.stripe.paymentIntents.create(...)` with
  `capture_method` from `captureMethod` (defaults to `'manual'` for J5) and
  passes the `idempotencyKey` through to Stripe's idempotency mechanism. It
  returns a `clientSecret` for Stripe Elements (an embedded-SDK flow, not a
  redirect). `supportsRecurring` and `supportsSplitPayments` are both `true`.
- `StripeWebhookHandler` (`stripe-webhook-handler.ts:34`) parses real Stripe
  events (`rawPayload.id`, `.type`, `.data.object`) and maps
  `payment_intent.*` statuses via `mapStripeStatus`.
- `addStripeProvider(services, config)` (`index.ts:58`) registers both under the
  key `'stripe'`. Stripe webhooks are HMAC-signed, so verification uses the
  Stripe-style scheme.

### 3.2 Example: SUMIT (hosted redirect + unsigned URL-token webhook)

Files: `packages/payments-sumit/src/` → `sumit-provider.ts`,
`sumit-webhook-handler.ts`, `sumit-types.ts`, `factory.ts`, `index.ts`. See also
`docs/billing-sumit.md`.

- `SumitProvider` (`sumit-provider.ts:84`) `implements IPaymentProvider,
  ISubscriptionProvider`. It uses plain `fetch` (no SDK) to POST JSON to
  `https://api.sumit.co.il`, with every body carrying
  `Credentials: { CompanyID, APIKey }`.
  - `createPaymentIntent` POSTs to `/billing/payments/beginredirect/` and returns
    a **`redirectUrl`** (a hosted PCI-safe page) — no `clientSecret`. SUMIT does
    not return a payment id here, so the adapter uses the app's own
    `internalOrderId` (from `metadata.orderId` or `idempotencyKey`) as the
    `providerIntentId`, embeds it as SUMIT's `ExternalIdentifier`, and appends
    `?internal_order_id=...` to the return URL so both the redirect and webhook
    can be matched back.
  - SUMIT is **single-phase**: `authorize`/`capture` are shims that query
    `/billing/payments/get/` and resolve from `Data.Payment.ValidPayment`; `void`
    and `refund` return "not supported" (do them in the SUMIT dashboard).
  - `createSubscription` POSTs to `/billing/recurring/charge/` and **requires a
    `paymentMethodToken`** (the recurring API is server-to-server and can't
    collect a card). `cancelSubscription` cancels by numeric
    `RecurringCustomerItemID`.
  - `validateWebhookSignature` does a **constant-time compare of a URL token**
    against `config.webhookToken` (there is no HMAC).
- `SumitWebhookHandler` (`sumit-webhook-handler.ts:43`) normalizes SUMIT's
  View-driven trigger payloads. Because the payload shape is configurable, it
  reads candidate field names defensively (`pick(...)`) and derives one of six
  unified events. Critically, `eventId` is **stable** (`${paymentId}:${eventType}`,
  line 83), never time-based — so redeliveries dedupe.
- `addSumitProvider(services, config)` (`factory.ts:69`) registers under `'sumit'`
  **and** calls `registerSignatureVerifier('sumit', verifySumitToken)` so the
  base plugin's `verifyWebhookSignature` uses the token comparison instead of the
  default HMAC.

### 3.3 Stripe vs SUMIT contrast

| Aspect | Stripe | SUMIT |
|---|---|---|
| Transport | official `stripe` SDK | plain `fetch` JSON |
| Checkout | `clientSecret` (Elements) | hosted `redirectUrl` |
| Phases | true J5 authorize/capture | single-phase (capture/authorize are shims) |
| Webhook auth | HMAC signature (`t=,v1=`) | unsigned URL token (constant-time compare) |
| Webhook id | provider event id | synthesized `paymentId:eventType` |
| Refund/void | supported | not via API (dashboard) |
| Currency | ISO strings | enum-named strings ILS/USD/EUR |

The IL plugin (`packages/payments-il/`) follows the same anatomy for `hyp` and
`cardcom` via `addIsraeliProviders(services, config)` and additionally exports
Israeli BIN routing rules (`ISRAELI_ROUTING_RULES`) for the optional routing
engine.

---

## 4. How a payment flows end to end

### 4.1 One-time purchase (SUMIT redirect example)

1. **App creates a checkout.** Your billing service calls
   `services.providers.get('sumit').createPaymentIntent({ amount: { amountMinor,
   currency }, userId, idempotencyKey: orderId, returnUrl, metadata: { orderId,
   customerEmail } })`. The adapter returns `{ redirectUrl, providerIntentId:
   orderId, status: 'created' }`.
2. **User pays.** You redirect the user to `redirectUrl` (or embed it). They
   complete the payment on the provider's hosted page.
3. **Webhook arrives.** The provider POSTs to your route. The route verifies
   authenticity (URL token for SUMIT; HMAC header for Stripe), then calls
   `webhookHandlers.get(provider).parseEvent(rawPayload)`.
4. **Normalized event.** You get a `ParsedWebhookEvent` with
   `eventType: 'payment.succeeded'`, `providerTransactionId`, `amountMinor`,
   `currency`.
5. **Idempotent persist.** The app inserts a `payment_webhook_events` row keyed
   by the unique `(provider, provider_event_id)` constraint
   (`webhook-events.ts:66`). A redelivery hits the constraint and is a no-op — so
   credits are never granted twice.
6. **Confirm + grant.** Because the SUMIT webhook is unsigned, the app calls
   `provider.getPaymentIntentStatus(...)` (or the handler's `reconcile`, which
   queries SUMIT) before trusting it. On confirmed success the app marks the
   order `paid` and grants credits through its domain layer
   (e.g. `@nehorai/credits`).

> The adapter does **not** grant credits or write order state. It only emits the
> normalized event; the app owns everything downstream.

### 4.2 Subscription / recurring variant

1. **Get a card token first** (SUMIT). The recurring API can't collect card
   details, so obtain a single-use token via the SUMIT Payments JS API in the
   browser (or reuse a method saved by a prior checkout).
2. `createSubscription({ amount, userId, idempotencyKey, paymentMethodToken,
   recurrenceCount? })` posts a standing order and returns
   `providerSubscriptionId` (the `RecurringCustomerItemID`) and a `status`
   (`'active'` or `'past_due'`).
3. **Each cycle**, the provider bills and fires a webhook. The handler normalizes
   it to `subscription.renewed` / `subscription.payment_failed` /
   `subscription.canceled`. The app maps those onto its subscription state and
   reloads that period's credits (same idempotency rule applies).
4. **Cancel** with `cancelSubscription({ providerSubscriptionId })`.

For the orchestrated multi-provider path, `PaymentOrchestrator.initiatePayment`
performs steps 1–2 across routing + failover, but the normalized result and
webhook handling are identical.

---

## 5. Configuration & secrets

The base plugin is config-source-agnostic (`config/payment-config.ts`).

- **`PaymentConfig`** (line 55) = `{ providers, environment: 'sandbox' |
  'production', defaultCurrency }`. `providers` is an open map of
  provider-name → arbitrary key/value config.
- **`createConfigFromEnv(mapping)`** (line 113) builds a `PaymentConfig` from
  `process.env` given an `EnvMappingConfig` that maps config keys → env var
  names per provider, with optional `requiredKeys`. There is also `createConfig`,
  `createPartialConfig`, and validators (`validateConfig`, `isProductionReady`,
  `getConfiguredProviderList`).

In practice, each **provider plugin** owns its own config shape and you pass it
straight to its `addXProvider` factory — the base `PaymentConfig` is mostly used
by the optional routing engine and for "which providers are configured" checks.

Per-provider env vars (examples from the code/docs):

- **Stripe**: `STRIPE_SECRET_KEY`, `STRIPE_PUBLISHABLE_KEY`,
  `STRIPE_WEBHOOK_SECRET` (the mapping in `payment-config.ts`'s docblock).
- **SUMIT**: `SUMIT_COMPANY_ID_*`, `SUMIT_API_KEY_*`, `SUMIT_WEBHOOK_TOKEN_*`,
  optional `SUMIT_BASE_URL_*` (see `docs/billing-sumit.md`).

**Test/prod separation is by injected config, not code branches** — you select
`*_TEST` vs `*_PROD` env vars when constructing the provider. All keys are
**server-side only**; never ship them to the client, and all provider calls run
on the server.

---

## 6. Persistence

The Postgres adapter is `@nehorai/payments-drizzle`
(`packages/payments-drizzle/src/`). It supplies the real implementations of the
base plugin's repository interfaces and the Drizzle schema:

- **`payment_transactions`** (`schema/payment-transactions.ts:64`) — the J5
  ledger: `internal_payment_id` (unique), `idempotency_key` (unique),
  `status`/`transaction_type`, `amount_minor`/`currency`, provider columns,
  two-phase timestamps (`authorized_at`, `captured_at`, `voided_at`,
  `capture_deadline`), refund tracking, and Israeli tax-invoice fields. The
  unique constraints enforce idempotent charges.
- **`payment_webhook_events`** (`schema/webhook-events.ts:26`) — incoming
  webhooks with the **`unique(provider, provider_event_id)`** constraint
  (`webhook_events_provider_event_unique`, line 66) that makes webhook processing
  exactly-once. Stores `payload` and `signature` for debugging/retry.
- **`payment_methods`** (`schema/payment-methods.ts`) — tokenized methods
  (PCI-safe; no PANs). Plus `payment_audit_log` and `provider_health`.

Repository classes (`DrizzleTransactionRepository`,
`DrizzleWebhookEventRepository`, …) and a `createDrizzleRepositories` /
`createDrizzlePaymentServices` factory are exported from
`payments-drizzle/src/index.ts`. There's also `DrizzleCircuitBreakerStorage` for
persisting circuit-breaker state.

> Note the FK to your users table is intentionally **not** defined in the schema
> (`payment-transactions.ts` docblock) — it's application-specific and added via
> migration. The app owns user/order tables; the plugin owns payment tables.

---

## 7. Next.js integration

`@nehorai/payments-nextjs` (`packages/payments-nextjs/src/`) provides App Router
handler factories — the **app mounts the routes**, the factory supplies the
handler. Exports include `createWebhookRouteHandler`, plus
`createIntentsRouteHandler`, `createConfirmRouteHandler`,
`createCaptureRouteHandler`, `createVoidRouteHandler`, `createMethodsRouteHandler`,
`createTransactionsRouteHandler`, `createProvidersRouteHandler`,
`createHealthRouteHandler`, and server actions (`createInitiatePaymentAction`,
`createCapturePaymentAction`).

`createWebhookRouteHandler(options)` (`handlers/webhook-handler.ts:25`) returns a
`POST(request, { params })` handler mounted at e.g.
`app/api/payments/webhooks/[provider]/route.ts`. Its flow:

1. validate the `[provider]` param against `services.providers` keys,
2. read the **raw body** via `request.text()` (required for signature
   verification),
3. read the signature header from `getSignatureHeaderName(provider)`
   (`x-<provider>-signature`),
4. fetch the secret via `options.getWebhookSecret(provider)`,
5. `verifyWebhookSignature({ provider, payload, signature, secret })`,
6. `JSON.parse` the body, look up `webhookHandlers.get(provider)`, then
   `parseEvent` → `processEvent`.

**Important caveat for SUMIT.** This generic handler is **header + HMAC**
oriented: it requires a non-empty signature *header* and returns `401` if it's
missing. SUMIT's authenticity is a **token in the webhook URL query string**
(`?token=...`), not a header. So for SUMIT you mount a small custom route that
reads `token` from the URL, verifies it (via `verifySumitToken` /
`provider.validateWebhookSignature(rawBody, token)`), then calls
`handler.parseEvent(...)` — exactly as `docs/billing-sumit.md` describes. The
shared `createWebhookRouteHandler` fits HMAC-header providers like Stripe
out of the box; SUMIT needs the thin custom variant. (This is a real seam in the
code, worth flagging.)

---

## 8. How to add a NEW provider

Mirror an existing adapter (Stripe is the cleanest template; SUMIT shows the
redirect + unsigned-webhook variant):

1. **Create a package** `@nehorai/payments-<x>` depending on `@nehorai/payments`.
2. **Types/config** (`<x>-types.ts`): the provider's request/response shapes,
   supported currencies, status/error mappers, and an `XConfig` interface.
3. **Provider class** (`<x>-provider.ts`) `implements IPaymentProvider` (add
   `ISubscriptionProvider` if it does recurring). Set `name`,
   `supportedCurrencies`, `supportsRecurring`, `supportsSplitPayments`. Implement
   `createPaymentIntent` and the J5 methods (shim `authorize`/`capture` if the
   provider is single-phase), `refund`, the tokenization/customer methods (stub
   the ones it doesn't support, as SUMIT does), `getHealth`,
   `validateWebhookSignature`, `getPaymentIntentStatus`. Convert money to/from
   `PaymentAmount` minor units. Take config via the constructor — **never read
   env directly**.
4. **Webhook handler** (`<x>-webhook-handler.ts`) `implements IWebhookHandler`.
   In `parseEvent`, produce a `ParsedWebhookEvent` with a **stable, idempotent
   `eventId`** and a normalized `eventType`. Implement `reconcile` to re-query
   the provider when its webhook can't be fully trusted.
5. **Factory** (`index.ts` / `factory.ts`): export
   `addXProvider(services, config)` that does
   `services.providers.set('<x>', new XProvider(config))` and
   `services.webhookHandlers.set('<x>', new XWebhookHandler(...))`. If the
   provider's webhook auth isn't plain HMAC, call
   `registerSignatureVerifier('<x>', myVerifier)` (the SUMIT pattern).
6. **(Optional) routing**: export `RoutingRules` (BIN/priority/currency) if you
   want the orchestrator to consider it.
7. **Tests**: unit-test the adapter with **mocked `fetch`/SDK** (see
   `packages/payments-sumit/__tests__/`).
8. **(Optional) persistence/Next.js**: the existing Drizzle schema and Next.js
   handlers are provider-agnostic and need no changes for a new provider (except
   a custom webhook route if it isn't HMAC-header based).

---

## 9. Do you even need all this? (honest, for one small business)

Context: one small business, several digital products (Story Creator,
podcasToYOU, Maklikim, AI Games), and a single Israeli provider (SUMIT). You
correctly observe that you don't swap payment providers every other day. So here
is the pragmatic read.

### What is overkill at your scale

The **multi-provider machinery is enterprise-grade and almost certainly more than
you need**:

- **`RoutingEngine`** (BIN-based routing, currency rules, provider priorities) —
  it only earns its keep when you have *several* providers to route *between*.
  With one provider there's nothing to route.
- **`CircuitBreaker`** + `ProviderHealth` — designed to fail over when a provider
  is down. With one provider, "fail over to what?" If SUMIT is down, you're down;
  a breaker doesn't change that.
- **`PaymentOrchestrator`'s `tryFailover`** — same story; the fallback list is
  empty for a single provider.

You can ignore the orchestrator, routing engine and circuit breaker **entirely**.
Don't even construct them: call the SUMIT adapter directly behind your own thin
billing service:

```ts
const services = createPaymentServices({ providers: new Map() });
addSumitProvider(services, { companyId, apiKey, webhookToken });

const sumit = services.providers.get('sumit')!;
const { redirectUrl } = await sumit.createPaymentIntent({ /* ... */ });
```

(That said, `createPaymentServices` *does* build the optional services even if you
never call them — they're cheap and idle. You simply never invoke
`orchestrator`/`routingEngine`. Nothing forces you to use them.)

### What is genuinely worth keeping, even for one provider + many products

- **The stable normalized contract.** Your apps depend on `IPaymentProvider`,
  `ParsedWebhookEvent` and `TransactionStatus` — *not* on SUMIT's quirks (the
  unsigned URL-token webhook, the enum-named currencies, `ExternalIdentifier`,
  major-vs-minor units). All of that ugliness is quarantined inside one adapter.
  If SUMIT ever changes a field, you fix one file, not four products.
- **Unit-testability.** The adapter is tested with mocked `fetch`
  (`packages/payments-sumit/__tests__/`), so you can verify payment logic without
  hitting SUMIT and without secrets.
- **One billing seam across all products.** Story Creator, podcasToYOU, Maklikim
  and AI Games all share the same `createPaymentIntent` → webhook → normalized
  event → grant-credits flow. That seam is cheap to keep and saves you
  reimplementing checkout per product.
- **The idempotency discipline.** The stable `eventId` + the
  `webhook_events (provider, provider_event_id)` unique constraint is what
  prevents double-granting credits on webhook redelivery. Keep this regardless of
  scale — it's the part most likely to bite you if dropped.

### Bottom line

**Use the thin slice; adopt the rest deliberately.** Keep the base contracts +
the SUMIT adapter + the webhook idempotency — they cost almost nothing and buy a
clean, testable, product-agnostic billing seam. You *do* plan a second
(international) provider for **segmentation** and possibly **cost** routing, so
section 10 maps that roadmap concretely. Even then, you can **skip the circuit
breaker / automatic failover** (that's for redundancy, which isn't your goal).
The orchestration layer stays on the shelf until you actually need cross-provider
failover.

---

## 10. Your roadmap: segmentation + cost, hosted-only

You plan to add an international provider for overseas customers
(**segmentation**), maybe route by fee later (**cost**), and — importantly — you
want to **rely on the providers' hosted checkout UIs and not build your own
payment UI**, for security. Here's how that maps onto the plugin.

### 10.1 Security posture: hosted checkout only (recommended)

Relying on the provider's hosted page is the right call:

- Card data goes **straight from the user to the provider** and never touches
  your servers → you stay in the smallest PCI scope (SAQ-A): no card storage, no
  card fields to secure, far less to get wrong.
- In adapter terms: rely on `PaymentIntentResult.redirectUrl` (the hosted page),
  **not** `clientSecret` (Stripe Elements / embedded card fields, which require
  your own UI and widen PCI scope).
- SUMIT already works this way — `createPaymentIntent` → `beginredirect` →
  hosted page. For the international provider, pick one with a hosted flow:
  **Stripe Checkout / Payment Links**, **Paddle**, or **Lemon Squeezy**.

> **Subscription caveat (hosted-only).** SUMIT's *recurring API*
> (`/billing/recurring/charge/`) needs a card token, which implies a small JS
> widget — i.e. some UI. For a fully hosted recurring flow you either (a) use
> SUMIT's hosted payment page configured with a recurring product/standing order
> (verify this in the SUMIT product setup), or (b) use an international provider
> whose hosted checkout supports subscription mode natively (Stripe Checkout
> subscriptions, Paddle, Lemon Squeezy). For overseas subscriptions, (b) is the
> cleaner path — and Paddle / Lemon Squeezy are **merchant-of-record**, so they
> also handle global VAT/sales-tax for you.

### 10.2 Segmentation = explicit selection (registry, not routing engine)

Choosing a provider by the customer's region is best done with your own signal
(account country, selected currency), in a thin helper — not BIN-based routing:

```ts
// your billing layer
function chooseProvider(ctx: { country: string }): 'sumit' | 'stripe' {
  return ctx.country === 'IL' ? 'sumit' : 'stripe';
}

const provider = services.providers.get(chooseProvider({ country: user.country }))!;
const { redirectUrl } = await provider.createPaymentIntent({ /* ... */ });
// then redirect the user to the provider's hosted page
```

That's all segmentation needs — the `providers` registry already holds both, no
orchestrator required. (The optional `RoutingEngine` *does* receive a
`userCountry` in its `RoutingContext`, but the built-in rules route by card
BIN / currency / fee, not country — so an explicit helper is clearer for
region-based segmentation.)

### 10.3 Cost optimization = RoutingEngine (when you have fee data)

When you actually want "cheapest eligible provider," that's exactly what the
RoutingEngine is for — adopt it *then*, without changing any adapter. Its public
method is `route(context)` → `RoutingDecision`:

```ts
const decision = await services.routingEngine.route({
  userId: user.id,
  amount: { amountMinor, currency },
  isRecurring: false,
  // cardBin?, userCountry? optional context
});
const provider = services.providers.get(decision.provider)!;
// decision also carries reason, estimatedFeePercent, fallbackProviders
```

Configure `ProviderPriorityRule` (priority + `maxFeePercent`) and `CurrencyRule`
in the injected `RoutingRules`. Ignore `decision.fallbackProviders` and the
**CircuitBreaker** — failover is for redundancy, which isn't your goal (you don't
want Israeli payments silently routed to an international provider on a blip).

### 10.4 What this means in practice

- **Now (one provider):** just the SUMIT adapter; no `chooseProvider`, no routing.
- **When the international provider lands:** add its adapter
  (`addStripeProvider` / a Paddle adapter following the same anatomy) + a
  `chooseProvider` helper. The SUMIT adapter and your product code stay
  **untouched** — that's the payoff of the abstraction.
- **Later, if fees justify it:** turn on the `RoutingEngine` for cost. Still no
  failover.
- **Throughout:** prefer hosted `redirectUrl` flows; never collect card data
  yourself.

---

## Reference (file map)

- Base public surface: `packages/payments/src/index.ts`
- Factory / registry: `packages/payments/src/factory.ts`
- Provider contracts: `packages/payments/src/providers/interfaces/`
- Normalized types / J5 state machine:
  `packages/payments/src/types/{payment-types,state-machine,webhook-types}.ts`
- Optional services: `packages/payments/src/services/`
- Config: `packages/payments/src/config/payment-config.ts`
- Signature verification: `packages/payments/src/utils/signature-verification.ts`
- Repository interfaces / in-memory ref:
  `packages/payments/src/repository/{interfaces,memory}/`
- Stripe adapter: `packages/payments-stripe/src/`
- Israeli adapters (Hyp, Cardcom) + routing: `packages/payments-il/src/`
- SUMIT adapter: `packages/payments-sumit/src/` (and `docs/billing-sumit.md`)
- Drizzle persistence: `packages/payments-drizzle/src/`
- Next.js integration: `packages/payments-nextjs/src/handlers/`

