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

Charge mapping that MUST be correct (verified against the live swagger; getting
these wrong silently overcharges or fails):
- Put the amount in **`ChargeItem.UnitPrice`** (a required field), not `Item.Price`.
- Send **`VATIncluded: true`** when your prices are VAT-inclusive. SUMIT defaults
  to `false` and would **add VAT on top** (₪49 → ₪57.82), which then fails your
  amount check. Plugin ≥ 0.2.1 does both correctly.
- Amounts cross the plugin boundary in **major units** (shekels), not agorot.

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

## 7. Test org (sandbox, no real charges)

`help.sumit.co.il/he/articles/5840939`: org-switcher → "יצירת עסק חדש" (name must
contain "בדיקות") → install the free API module → connect a test terminal at
`app.sumit.co.il/developers/testterminal` (this **disconnects real card
processing** — that's why it must be a separate org) → mint key at
`/developers/keys/` → fill פרטי עסק (the מספר עוסק must be globally unique in
SUMIT). Test cards: `help.sumit.co.il/he/articles/5832877` (e.g. Visa
`4557430402321333`, exp `05/31`, CVV `098`).
