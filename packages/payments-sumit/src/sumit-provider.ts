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
    params: CreateSubscriptionParams
  ): Promise<SubscriptionResult> {
    // SUMIT's recurring API charges a tokenized card directly — it cannot
    // collect card details. A token is obtained beforehand via the SUMIT
    // Payments JS API (single-use token) or a saved payment method created by
    // a prior hosted checkout. See docs/billing-sumit.md.
    if (!params.paymentMethodToken) {
      return {
        success: false,
        error:
          'createSubscription requires paymentMethodToken (a SUMIT single-use card token).',
      };
    }

    try {
      const amountMajor = params.amount.amountMinor / 100;
      const description = params.description ?? 'Subscription';

      const request: SumitRecurringChargeRequest = {
        Credentials: buildCredentials(this.config),
        Customer: {
          Name: params.metadata?.customerName as string | undefined,
          EmailAddress: params.metadata?.customerEmail as string | undefined,
          Phone: params.metadata?.customerPhone as string | undefined,
          ExternalIdentifier: params.userId,
        },
        SingleUseToken: params.paymentMethodToken,
        Items: [
          {
            Item: {
              Name: description,
              Price: amountMajor,
              Currency: params.amount.currency,
            },
            Quantity: 1,
            Duration_Months: 1,
            Recurrence: params.recurrenceCount,
            Description: params.idempotencyKey,
          },
        ],
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

      const recurringId =
        response.Data?.Payment?.RecurringCustomerItemIDs?.[0];

      return {
        success: true,
        providerSubscriptionId:
          recurringId !== undefined ? String(recurringId) : undefined,
        status: response.Data?.Payment?.ValidPayment === false ? 'past_due' : 'active',
      };
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Unknown error occurred';
      return { success: false, error: message };
    }
  }

  async cancelSubscription(
    params: CancelSubscriptionParams
  ): Promise<CancelSubscriptionResult> {
    try {
      const recurringItemId = Number(params.providerSubscriptionId);
      if (!Number.isFinite(recurringItemId)) {
        return {
          success: false,
          error: 'providerSubscriptionId must be a numeric RecurringCustomerItemID',
        };
      }

      const response = await this.makeRequest(
        SUMIT_ENDPOINTS.RECURRING_CANCEL,
        {
          Credentials: buildCredentials(this.config),
          RecurringCustomerItemID: recurringItemId,
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
