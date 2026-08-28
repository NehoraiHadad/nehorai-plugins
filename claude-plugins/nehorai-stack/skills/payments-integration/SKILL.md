---
name: payments-integration
description: >-
  Integrate the @nehorai/payments plugin family (base orchestration +
  provider adapters: Stripe, SUMIT, Hyp, Cardcom; Drizzle persistence;
  Next.js routes) into an app. Use whenever the user adds payment
  processing, chooses or swaps a payment provider, wires webhooks or
  checkout flows, needs multi-provider routing / circuit breaking, or asks
  how the payments packages fit together — even if they only say "add
  payments" or "accept credit cards". For SUMIT/UPAY specifics use the
  sumit-payments skill on top of this one.
---

# @nehorai/payments integration

You are wiring the payments family into an app. The one rule that explains
everything: **the base plugin defines contracts and optional orchestration;
each provider plugin is a thin adapter emitting normalized events; neither
knows about products, plans, credits, or users** — entitlements live in the
app (often via `@nehorai/credits`; see the `credits-integration` skill for
the grant seam).

## Sources of truth (read first)

- **Bundled guide — read before writing code:**
  `references/payments-plugin-guide.md` (next to this file). Written from
  source with `path:line` references: contracts (`IPaymentProvider`,
  `IWebhookHandler`, `ISubscriptionProvider`), normalized types and the
  transaction state machine, `PaymentServices` registry, orchestrator /
  routing / circuit breaker, and how each provider adapter plugs in.
- The installed package READMEs and `.d.ts` files in `node_modules/@nehorai/`
  — version-matched; prefer them over memory for exact signatures.
- SUMIT specifics (hosted checkout, verify-on-return, test org, the gotcha
  list): the `sumit-payments` skill.

## Package map

| Package | Role |
|---|---|
| `@nehorai/payments` | Base: contracts, normalized types, `PaymentServices` registry, optional orchestrator (routing + circuit breaker) |
| `@nehorai/payments-stripe` | Stripe provider |
| `@nehorai/payments-sumit` | SUMIT (UPAY) hosted-checkout provider |
| `@nehorai/payments-il` | Israeli providers (Hyp, Cardcom) |
| `@nehorai/payments-drizzle` | Drizzle ORM persistence adapter |
| `@nehorai/payments-nextjs` | Next.js App Router route handlers |

## Integration shape

1. Pick providers; install base + those adapters only.
2. Build a `PaymentServices` registry; register each provider and its webhook
   handler under its name.
3. App-side billing layer calls the provider (directly or through the
   orchestrator) with **minor units** and your order UUID as
   `externalIdentifier`.
4. Webhook/return routes parse to normalized events and hand them to ONE
   shared idempotent fulfilment function — the app grants entitlements there
   (with credits: `addCreditsV2({ paymentRef: '{provider}:{paymentId}' })`).
5. Keep provider secrets server-only; test vs prod = different env VALUES per
   environment, never a `NODE_ENV` code branch.

The guide covers each step with real signatures — do not guess method names
when the reference is one file away.
