/**
 * SUMIT (UPAY) Payment Provider
 *
 * Implements IPaymentProvider (one-time, hosted-redirect checkout) and the
 * optional ISubscriptionProvider (recurring standing orders) for SUMIT.
 *
 * Design notes (verified against the SUMIT OpenAPI spec):
 * - Checkout uses `/billing/payments/beginredirect/` → a hosted payment page
 *   (PCI-safe; card data never reaches us; Apple/Google Pay/Bit ride the same
 *   UPAY link). The response carries only `Data.RedirectURL`.
 * - SUMIT is single-phase (no J5 authorize/capture). `authorize`/`capture`
 *   therefore resolve by querying the payment (`/billing/payments/get/` →
 *   `Data.Payment`); `void` is unsupported via API.
 * - Recurring billing is server-to-server (`/billing/recurring/charge/`) and
 *   requires a card token, so `createSubscription` needs `paymentMethodToken`.
 * - SUMIT has no webhook HMAC, so `validateWebhookSignature` compares a shared
 *   URL token, and `getPaymentIntentStatus` provides the authoritative
 *   server-side verification the webhook lacks.
 *
 * The adapter never touches credits, plans, users or permissions — that logic
 * lives in the application's billing/domain layer.
 */

import { timingSafeEqual } from 'crypto';
import type {
  PaymentProvider,
  CreatePaymentIntentParams,
  PaymentIntentResult,
  AuthorizePaymentParams,
  AuthorizationResult,
  CapturePaymentParams,
  CaptureResult,
  VoidPaymentParams,
  VoidResult,
  RefundParams,
  RefundResult,
  ProviderHealthStatus,
  CreateSubscriptionParams,
  SubscriptionResult,
  CancelSubscriptionParams,
  CancelSubscriptionResult,
} from '@nehorai/payments/types';
import type {
  IPaymentProvider,
  ISubscriptionProvider,
  SavePaymentMethodParams,
  SavePaymentMethodResult,
  DeletePaymentMethodResult,
  CreateSetupIntentParams,
  SetupIntentResult,
  CreateCustomerParams,
  CreateCustomerResult,
} from '@nehorai/payments/providers';
import {
  SUMIT_API_BASE,
  SUMIT_ENDPOINTS,
  SUMIT_SUPPORTED_CURRENCIES,
  buildCredentials,
  isSumitSuccess,
  mapSumitError,
  mapSumitStatusToTransactionStatus,
  type SumitProviderConfig,
  type SumitResponse,
  type SumitBeginRedirectRequest,
  type SumitBeginRedirectData,
  type SumitGetPaymentData,
  type SumitPayment,
  type SumitRecurringChargeRequest,
  type SumitRecurringChargeData,
  type SumitRecurringItem,
  type SumitChargeRequest,
  type SumitChargeData,
  type SumitChargeCustomerParams,
  type SumitChargeCustomerResult,
  type SumitCreateSubscriptionExtra,
  type SumitCancelSubscriptionExtra,
  type SumitSubscriptionResultExtra,
  type VerifyPaymentParams,
  type VerifyPaymentResult,
} from './sumit-types.js';

/** Append a query parameter to a URL, preserving existing params. */
function appendQueryParam(url: string, key: string, value: string): string {
  try {
    const u = new URL(url);
    u.searchParams.set(key, value);
    return u.toString();
  } catch {
    const sep = url.includes('?') ? '&' : '?';
    return `${url}${sep}${encodeURIComponent(key)}=${encodeURIComponent(value)}`;
  }
}

export class SumitProvider implements IPaymentProvider, ISubscriptionProvider {
  readonly name: PaymentProvider = 'sumit';
  readonly supportedCurrencies = SUMIT_SUPPORTED_CURRENCIES;
  readonly supportsRecurring = true;
  readonly supportsSplitPayments = false;

  private readonly config: SumitProviderConfig;
  private readonly baseUrl: string;

  constructor(config: SumitProviderConfig) {
    if (!config.companyId || !config.apiKey) {
      throw new Error('SumitProvider requires companyId and apiKey in config');
    }
    this.config = config;
    this.baseUrl = config.baseUrl ?? SUMIT_API_BASE;
  }

  // ==========================================================================
  // Checkout (one-time) — hosted redirect
  // ==========================================================================

  async createPaymentIntent(
    params: CreatePaymentIntentParams
  ): Promise<PaymentIntentResult> {
    try {
      // The internal order id lets us match the webhook/redirect back to our
      // order. Prefer an explicit metadata.orderId; fall back to idempotencyKey.
      const internalOrderId =
        (params.metadata?.orderId as string | undefined) ?? params.idempotencyKey;

      const amountMajor = params.amount.amountMinor / 100;
      const description = params.description ?? 'Payment';
      const returnUrl = params.returnUrl
        ? appendQueryParam(params.returnUrl, 'internal_order_id', internalOrderId)
        : undefined;
      const cancelUrl = params.metadata?.cancelUrl as string | undefined;

      // The charged amount goes in ChargeItem.UnitPrice (the spec's required
      // field) — NOT Item.Price, which is only the catalog/income-item price.
      // VATIncluded defaults to true: amountMinor is the final amount to charge.
      // The SUMIT default is false (VAT added on top), so callers passing a
      // VAT-inclusive price must keep this true. Override via metadata if a
      // caller really passes pre-VAT prices.
      const vatIncluded =
        params.metadata?.vatIncluded === false ? false : true;

      // Default (unset) ⇒ SUMIT saves the card as the customer's default, which
      // Flow B's recurring charge later reuses. One-time purchases can opt out
      // by passing metadata.preventSavingPaymentMethod = true.
      const preventSavingPaymentMethod =
        params.metadata?.preventSavingPaymentMethod === true ? true : undefined;

      const request: SumitBeginRedirectRequest = {
        Credentials: buildCredentials(this.config),
        Customer: {
          Name: params.metadata?.customerName as string | undefined,
          EmailAddress: params.metadata?.customerEmail as string | undefined,
          Phone: params.metadata?.customerPhone as string | undefined,
          ExternalIdentifier: params.userId,
        },
        Items: [
          {
            Item: { Name: description },
            Quantity: 1,
            UnitPrice: amountMajor,
            Currency: params.amount.currency,
            Description: internalOrderId,
          },
        ],
        VATIncluded: vatIncluded,
        RedirectURL: returnUrl,
        CancelRedirectURL: cancelUrl,
        MaximumPayments: 1,
        PreventSavingPaymentMethod: preventSavingPaymentMethod,
        // SUMIT appends ExternalIdentifier to the RedirectURL (OG-ExternalIdentifier)
        // on success, so the redirect leg can be matched back to our order.
        ExternalIdentifier: internalOrderId,
        DocumentDescription: description,
      };

      const response = await this.makeRequest<SumitBeginRedirectData>(
        SUMIT_ENDPOINTS.BEGIN_REDIRECT,
        request
      );

      if (!isSumitSuccess(response) || !response.Data?.RedirectURL) {
        return {
          success: false,
          error: mapSumitError(response),
          errorCode: String(response.Status),
        };
      }

      return {
        success: true,
        // beginredirect does not return a payment id; the SUMIT PaymentID
        // arrives later via the webhook. We key on our own order id meanwhile.
        providerIntentId: internalOrderId,
        redirectUrl: response.Data.RedirectURL,
        status: 'created',
      };
    } catch (error) {
      return this.handleError(error);
    }
  }

  // ==========================================================================
  // Two-phase commit shims (SUMIT is single-phase)
  // ==========================================================================

  async authorize(params: AuthorizePaymentParams): Promise<AuthorizationResult> {
    const payment = await this.fetchPayment(params.providerIntentId);
    if (!payment.success || !payment.data) {
      return { success: false, error: payment.error ?? 'Payment not found' };
    }
    if (payment.data.ValidPayment === true) {
      return {
        success: true,
        authorizationCode: String(payment.data.ID ?? params.providerIntentId),
        status: 'authorized',
      };
    }
    return {
      success: false,
      error: 'Payment not completed',
      status: payment.data.ValidPayment === false ? 'failed' : 'pending_authorization',
    };
  }

  async capture(params: CapturePaymentParams): Promise<CaptureResult> {
    const payment = await this.fetchPayment(params.providerIntentId);
    if (!payment.success || !payment.data) {
      return { success: false, error: payment.error ?? 'Payment not found' };
    }
    if (payment.data.ValidPayment === true) {
      return {
        success: true,
        providerTransactionId: String(payment.data.ID ?? params.providerIntentId),
        status: 'captured',
        capturedAmount: {
          amountMinor: Math.round((payment.data.Amount ?? 0) * 100),
          currency: payment.data.Currency ?? params.amount?.currency ?? 'ILS',
        },
      };
    }
    return { success: false, error: 'Payment not authorized for capture' };
  }

  async void(_params: VoidPaymentParams): Promise<VoidResult> {
    return {
      success: false,
      error:
        'Void is not supported via the SUMIT API. Cancel/refund from the SUMIT dashboard.',
    };
  }

  async refund(_params: RefundParams): Promise<RefundResult> {
    // SUMIT's refund / credit-note endpoint is not exposed under the billing
    // payments API surface verified here; intentionally not implemented.
    return {
      success: false,
      error:
        'Refunds are not supported by the SUMIT adapter; issue them from the SUMIT dashboard.',
    };
  }

  // ==========================================================================
  // Subscriptions (recurring standing orders, server-to-server)
  // ==========================================================================

  async createSubscription(
    params: CreateSubscriptionParams & SumitCreateSubscriptionExtra
  ): Promise<SubscriptionResult & SumitSubscriptionResultExtra> {
    // SUMIT's recurring API charges a saved card server-to-server. Two ways to
    // identify the card (see docs/billing-sumit.md):
    //  - Flow B (preferred): `providerCustomerId` (the OG-CustomerID from a prior
    //    hosted beginredirect that saved the card) ⇒ no token needed.
    //  - Token: a SUMIT Payments-JS single-use token.
    if (!params.providerCustomerId && !params.paymentMethodToken) {
      return {
        success: false,
        error:
          'createSubscription requires providerCustomerId (a saved SUMIT customer) or paymentMethodToken (a single-use card token).',
      };
    }

    try {
      const amountMajor = params.amount.amountMinor / 100;
      const description = params.description ?? 'Subscription';

      // The price goes in the SIBLING ChargeRecurringItem.UnitPrice — NOT
      // Item.Price, which SUMIT rejects with "Missing Item.UnitPrice".
      const item: SumitRecurringItem = {
        Item: { Name: description },
        Quantity: 1,
        UnitPrice: amountMajor,
        Currency: params.amount.currency,
        Duration_Months: 1,
        // 0 / undefined ⇒ open-ended standing order (charge until cancelled).
        Recurrence: params.recurrenceCount ?? 0,
        Description: params.idempotencyKey,
      };
      // Future Date_Start defers the first recurring bill so signup is charged
      // exactly once (by the preceding one-time beginredirect).
      if (params.startDate) {
        item.Date_Start = params.startDate;
      }

      // No-token Flow B path references the saved card by customer id; the token
      // path supplies a SingleUseToken and a fresh customer envelope.
      const numericCustomerId = params.providerCustomerId
        ? Number(params.providerCustomerId)
        : undefined;

      const request: SumitRecurringChargeRequest = {
        Credentials: buildCredentials(this.config),
        Customer:
          numericCustomerId !== undefined && Number.isFinite(numericCustomerId)
            ? { ID: numericCustomerId }
            : {
                Name: params.metadata?.customerName as string | undefined,
                EmailAddress: params.metadata?.customerEmail as string | undefined,
                Phone: params.metadata?.customerPhone as string | undefined,
                ExternalIdentifier: params.userId,
              },
        SingleUseToken: params.providerCustomerId
          ? undefined
          : params.paymentMethodToken,
        Items: [item],
        VATIncluded: true,
        // Stamp our id on the standing order so each renewal payment echoes it
        // (`OG-ExternalIdentifier`) and the webhook can resolve the subscription.
        ExternalIdentifier: params.externalIdentifier ?? params.idempotencyKey,
      };

      const response = await this.makeRequest<SumitRecurringChargeData>(
        SUMIT_ENDPOINTS.RECURRING_CHARGE,
        request
      );

      if (!isSumitSuccess(response)) {
        return {
          success: false,
          error: mapSumitError(response),
          errorCode: String(response.Status),
        };
      }

      // The standing-order id is surfaced both on the Payment and at the top
      // level of the recurring response — prefer either.
      const recurringId =
        response.Data?.Payment?.RecurringCustomerItemIDs?.[0] ??
        (response.Data as SumitRecurringChargeData & {
          RecurringCustomerItemIDs?: number[];
        })?.RecurringCustomerItemIDs?.[0];

      // What this recurring/charge captured NOW. With a future Date_Start the
      // first bill is deferred, so this should be 0/undefined; a positive value
      // means SUMIT charged immediately (the caller can detect a double charge).
      const immediateAmount = response.Data?.Payment?.Amount;
      const immediateChargeAmountMinor =
        immediateAmount != null ? Math.round(immediateAmount * 100) : undefined;

      return {
        success: true,
        providerSubscriptionId:
          recurringId !== undefined ? String(recurringId) : undefined,
        status: response.Data?.Payment?.ValidPayment === false ? 'past_due' : 'active',
        immediateChargeAmountMinor,
      };
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Unknown error occurred';
      return { success: false, error: message };
    }
  }

  async cancelSubscription(
    params: CancelSubscriptionParams & SumitCancelSubscriptionExtra
  ): Promise<CancelSubscriptionResult> {
    try {
      const recurringItemId = Number(params.providerSubscriptionId);
      if (!Number.isFinite(recurringItemId)) {
        return {
          success: false,
          error: 'providerSubscriptionId must be a numeric RecurringCustomerItemID',
        };
      }

      // SUMIT's recurring/cancel requires the owning customer in addition to the
      // RecurringCustomerItemID (Customer-missing ⇒ "יש להזין ערך בשדה Customer").
      const numericCustomerId = params.providerCustomerId
        ? Number(params.providerCustomerId)
        : undefined;

      const response = await this.makeRequest(
        SUMIT_ENDPOINTS.RECURRING_CANCEL,
        {
          Credentials: buildCredentials(this.config),
          RecurringCustomerItemID: recurringItemId,
          ...(numericCustomerId !== undefined && Number.isFinite(numericCustomerId)
            ? { Customer: { ID: numericCustomerId } }
            : {}),
        }
      );

      if (!isSumitSuccess(response)) {
        return { success: false, error: mapSumitError(response) };
      }

      return { success: true, status: 'canceled', canceledAt: new Date() };
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Unknown error occurred';
      return { success: false, error: message };
    }
  }

  /**
   * One-off server-to-server charge of a SAVED customer's default card
   * (`/billing/payments/charge/`) — no token, referenced by `providerCustomerId`
   * (the `OG-CustomerID` from a prior hosted `beginredirect` that saved the card).
   *
   * Use for ad-hoc charges that are NOT a standing order — e.g. a plan-change
   * proration (the price difference charged immediately on an upgrade). Returns
   * the captured payment id + amount so the caller can anchor the amount and
   * record the charge before granting anything.
   */
  async chargeCustomer(
    params: SumitChargeCustomerParams
  ): Promise<SumitChargeCustomerResult> {
    const numericCustomerId = Number(params.providerCustomerId);
    if (!Number.isFinite(numericCustomerId)) {
      return {
        success: false,
        error:
          'chargeCustomer requires a numeric providerCustomerId (a saved SUMIT customer).',
      };
    }

    try {
      const amountMajor = params.amount.amountMinor / 100;
      const description = params.description ?? 'Charge';

      const request: SumitChargeRequest = {
        Credentials: buildCredentials(this.config),
        Customer: { ID: numericCustomerId },
        Items: [
          {
            Item: { Name: description },
            Quantity: 1,
            // The charged amount goes in ChargeItem.UnitPrice (the required
            // field) — NOT Item.Price. amountMinor is the VAT-inclusive total.
            UnitPrice: amountMajor,
            Currency: params.amount.currency,
            Description: params.externalIdentifier,
          },
        ],
        VATIncluded: true,
        MaximumPayments: 1,
        DocumentDescription: description,
      };
      if (params.externalIdentifier) {
        request.ExternalIdentifier = params.externalIdentifier;
      }

      const response = await this.makeRequest<SumitChargeData>(
        SUMIT_ENDPOINTS.CHARGE,
        request
      );

      if (!isSumitSuccess(response)) {
        return {
          success: false,
          error: mapSumitError(response),
          errorCode: String(response.Status),
        };
      }

      const payment = response.Data?.Payment;
      if (payment?.ValidPayment !== true) {
        return { success: false, error: 'Charge was not approved', status: 'failed' };
      }

      const amountMinor =
        payment.Amount != null ? Math.round(payment.Amount * 100) : undefined;
      const documentNumber = response.Data?.DocumentNumber;

      return {
        success: true,
        providerPaymentId: payment.ID != null ? String(payment.ID) : undefined,
        amountMinor,
        documentNumber:
          documentNumber != null ? String(documentNumber) : undefined,
        status: 'captured',
      };
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Unknown error occurred';
      return { success: false, error: message };
    }
  }

  // ==========================================================================
  // Payment methods & customers (hosted page ⇒ minimal stubs)
  // ==========================================================================

  async createSetupIntent(
    _params: CreateSetupIntentParams
  ): Promise<SetupIntentResult> {
    return {
      success: false,
      error:
        'Standalone setup intents are not supported; tokenize via the SUMIT Payments JS API.',
    };
  }

  async savePaymentMethod(
    _params: SavePaymentMethodParams
  ): Promise<SavePaymentMethodResult> {
    return {
      success: false,
      error: 'savePaymentMethod is not supported by the SUMIT adapter.',
    };
  }

  async deletePaymentMethod(
    _paymentMethodId: string
  ): Promise<DeletePaymentMethodResult> {
    return { success: true };
  }

  async createCustomer(
    params: CreateCustomerParams
  ): Promise<CreateCustomerResult> {
    // The hosted page collects/creates the customer; we key on our own userId.
    return { success: true, customerId: params.userId };
  }

  async getOrCreateCustomer(
    userId: string,
    email: string
  ): Promise<CreateCustomerResult> {
    return this.createCustomer({ userId, email });
  }

  // ==========================================================================
  // Health, security & queries
  // ==========================================================================

  async getHealth(): Promise<ProviderHealthStatus> {
    const start = Date.now();
    try {
      // A structured SUMIT envelope (even a business error) proves reachability.
      await this.makeRequest(SUMIT_ENDPOINTS.GET_PAYMENT, {
        Credentials: buildCredentials(this.config),
        PaymentID: 0,
      });
      return {
        provider: 'sumit',
        healthy: true,
        lastChecked: new Date(),
        avgLatencyMs: Date.now() - start,
        circuitBreakerOpen: false,
      };
    } catch {
      return {
        provider: 'sumit',
        healthy: false,
        lastChecked: new Date(),
        circuitBreakerOpen: false,
      };
    }
  }

  /**
   * SUMIT provides no webhook HMAC; authenticity is a shared token carried in
   * the webhook URL. Compared in constant time against the configured token.
   */
  validateWebhookSignature(_payload: string, signature: string): boolean {
    if (!this.config.webhookToken || !signature) {
      return false;
    }
    try {
      const a = Buffer.from(signature);
      const b = Buffer.from(this.config.webhookToken);
      return a.length === b.length && timingSafeEqual(a, b);
    } catch {
      return false;
    }
  }

  async getPaymentIntentStatus(
    providerIntentId: string
  ): Promise<{ status: string; error?: string }> {
    const payment = await this.fetchPayment(providerIntentId);
    if (!payment.success || !payment.data) {
      return { status: 'unknown', error: payment.error };
    }
    return { status: mapSumitStatusToTransactionStatus(payment.data.ValidPayment) };
  }

  /**
   * Authoritative payment lookup (verify-on-return / webhook reconciliation).
   * Returns the raw SUMIT Payment (`ValidPayment`, `Amount`, `Currency`,
   * `ExternalIdentifier`, ...) so the application can compare the amount and
   * order binding against its own records before granting anything.
   */
  async getPayment(
    paymentId: string | number
  ): Promise<{ success: boolean; payment?: SumitPayment; error?: string }> {
    const result = await this.fetchPayment(paymentId);
    return { success: result.success, payment: result.data, error: result.error };
  }

  /**
   * Verify-on-return security anchor. Fetches the payment and gates a grant on
   * SUMIT's `ValidPayment` flag and, when `expectedAmountMinor` is supplied, an
   * exact amount match (the reported major-unit Amount ×100). Consuming apps
   * should treat {@link VerifyPaymentResult.verified} as the single source of
   * truth before granting anything — it is true ONLY when the payment is valid
   * AND (no expected amount was given OR the amount matches).
   */
  async verifyPayment(params: VerifyPaymentParams): Promise<VerifyPaymentResult> {
    const result = await this.fetchPayment(params.paymentId);
    if (!result.success || !result.data) {
      return { verified: false, valid: false, error: result.error };
    }
    const payment = result.data;
    const valid = payment.ValidPayment === true;
    const amountMinor =
      payment.Amount != null ? Math.round(payment.Amount * 100) : undefined;
    const amountMatches =
      params.expectedAmountMinor == null ? undefined : amountMinor === params.expectedAmountMinor;
    const verified = valid && (params.expectedAmountMinor == null || amountMatches === true);
    return { verified, valid, amountMatches, amountMinor, payment };
  }

  // ==========================================================================
  // Helpers
  // ==========================================================================

  private async fetchPayment(
    paymentId: string | number
  ): Promise<{ success: boolean; data?: SumitPayment; error?: string }> {
    try {
      const numericId = Number(paymentId);
      const response = await this.makeRequest<SumitGetPaymentData>(
        SUMIT_ENDPOINTS.GET_PAYMENT,
        {
          Credentials: buildCredentials(this.config),
          PaymentID: Number.isFinite(numericId) ? numericId : paymentId,
        }
      );
      if (!isSumitSuccess(response) || !response.Data?.Payment) {
        return { success: false, error: mapSumitError(response) };
      }
      return { success: true, data: response.Data.Payment };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Status check failed',
      };
    }
  }

  private async makeRequest<T>(
    endpoint: string,
    body: Record<string, unknown>
  ): Promise<SumitResponse<T>> {
    const url = `${this.baseUrl}${endpoint}`;
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      throw new Error(`SUMIT API error: ${response.status} ${response.statusText}`);
    }

    return (await response.json()) as SumitResponse<T>;
  }

  private handleError(error: unknown): {
    success: false;
    error: string;
  } {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error occurred',
    };
  }
}
