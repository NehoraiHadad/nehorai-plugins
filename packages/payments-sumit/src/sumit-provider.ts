/**
 * SUMIT (UPAY) Payment Provider
 *
 * Implements IPaymentProvider (one-time, hosted-redirect checkout) and the
 * optional ISubscriptionProvider (recurring standing orders) for SUMIT.
 *
 * Design notes:
 * - Checkout uses SUMIT `beginredirect` → a hosted payment page (PCI-safe;
 *   card data never reaches us; Apple/Google Pay/Bit ride the same UPAY link).
 * - SUMIT is single-phase (no J5 authorize/capture). `authorize`/`capture`
 *   therefore resolve by querying the payment; `void` is unsupported via API.
 * - SUMIT has no webhook HMAC, so `validateWebhookSignature` compares a
 *   shared URL token, and `getPaymentIntentStatus` provides the authoritative
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
  GetSubscriptionResult,
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
  SUMIT_STATUS_OK,
  SUMIT_SUPPORTED_CURRENCIES,
  buildCredentials,
  mapSumitError,
  mapSumitStatusToTransactionStatus,
  type SumitProviderConfig,
  type SumitResponse,
  type SumitBeginRedirectRequest,
  type SumitBeginRedirectData,
  type SumitPaymentData,
  type SumitRecurringData,
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

      const request = this.buildRedirectRequest(params, internalOrderId);

      const response = await this.makeRequest<SumitBeginRedirectData>(
        SUMIT_ENDPOINTS.BEGIN_REDIRECT,
        request
      );

      if (response.Status !== SUMIT_STATUS_OK || !response.Data) {
        return {
          success: false,
          error: mapSumitError(response),
          errorCode: String(response.Status),
        };
      }

      const redirectUrl =
        response.Data.RedirectURL ?? response.Data.PaymentLink;
      const providerIntentId =
        response.Data.PaymentID ??
        (response.Data.Payment?.ID !== undefined
          ? String(response.Data.Payment.ID)
          : undefined);

      if (!redirectUrl) {
        return {
          success: false,
          error: 'SUMIT did not return a redirect URL',
        };
      }

      return {
        success: true,
        providerIntentId: providerIntentId ?? internalOrderId,
        redirectUrl,
        status: 'created',
      };
    } catch (error) {
      return this.handleError(error);
    }
  }

  private buildRedirectRequest(
    params: CreatePaymentIntentParams,
    internalOrderId: string
  ): SumitBeginRedirectRequest {
    const amountMajor = params.amount.amountMinor / 100;
    const description = params.description ?? 'Payment';

    const returnUrl = params.returnUrl
      ? appendQueryParam(params.returnUrl, 'internal_order_id', internalOrderId)
      : undefined;

    return {
      Credentials: buildCredentials(this.config),
      Customer: {
        Name: params.metadata?.customerName as string | undefined,
        EmailAddress: params.metadata?.customerEmail as string | undefined,
        ExternalIdentifier: params.userId,
      },
      Items: [
        {
          Item: { Name: description, Price: amountMajor },
          Quantity: 1,
          Description: internalOrderId,
        },
      ],
      RedirectURL: returnUrl,
      MaximumPayments: 1,
      Language: 'he',
      // Echo the internal order id where SUMIT supports free text so it can be
      // recovered from the document/payment even if the webhook View omits it.
      Description: internalOrderId,
    };
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
    // SUMIT's refund/credit-note endpoint is not yet verified against the live
    // swagger; intentionally not implemented to avoid calling an unknown path.
    return {
      success: false,
      error:
        'Refunds are not yet supported by the SUMIT adapter (endpoint pending verification).',
    };
  }

  // ==========================================================================
  // Subscriptions (recurring standing orders)
  // ==========================================================================

  async createSubscription(
    params: CreateSubscriptionParams
  ): Promise<SubscriptionResult> {
    try {
      const internalOrderId = params.idempotencyKey;
      const amountMajor = params.amount.amountMinor / 100;
      const description = params.description ?? 'Subscription';

      const returnUrl = params.returnUrl
        ? appendQueryParam(params.returnUrl, 'internal_order_id', internalOrderId)
        : undefined;

      const request: SumitBeginRedirectRequest = {
        Credentials: buildCredentials(this.config),
        Customer: {
          Name: params.metadata?.customerName as string | undefined,
          EmailAddress: params.metadata?.customerEmail as string | undefined,
          ExternalIdentifier: params.userId,
        },
        Items: [
          {
            Item: { Name: description, Price: amountMajor },
            Quantity: 1,
            Description: internalOrderId,
          },
        ],
        RedirectURL: returnUrl,
        MaximumPayments: 1,
        Language: 'he',
        Description: internalOrderId,
        Recurrence: {
          DurationMonths: 1,
          RecurringCount: params.recurrenceCount,
        },
      };

      const response = await this.makeRequest<SumitBeginRedirectData>(
        SUMIT_ENDPOINTS.BEGIN_REDIRECT,
        request
      );

      if (response.Status !== SUMIT_STATUS_OK || !response.Data) {
        return {
          success: false,
          error: mapSumitError(response),
          errorCode: String(response.Status),
        };
      }

      const redirectUrl =
        response.Data.RedirectURL ?? response.Data.PaymentLink;
      const providerSubscriptionId =
        response.Data.PaymentID ??
        (response.Data.Payment?.ID !== undefined
          ? String(response.Data.Payment.ID)
          : internalOrderId);

      return {
        success: true,
        providerSubscriptionId,
        redirectUrl,
        // Becomes 'active' only once the first charge is confirmed by webhook.
        status: 'active',
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
      const response = await this.makeRequest<SumitRecurringData>(
        SUMIT_ENDPOINTS.CANCEL_RECURRING,
        {
          Credentials: buildCredentials(this.config),
          RecurringID: params.providerSubscriptionId,
        }
      );

      if (response.Status !== SUMIT_STATUS_OK) {
        return { success: false, error: mapSumitError(response) };
      }

      return {
        success: true,
        status: 'canceled',
        canceledAt: new Date(),
      };
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Unknown error occurred';
      return { success: false, error: message };
    }
  }

  async getSubscription(
    providerSubscriptionId: string
  ): Promise<GetSubscriptionResult> {
    try {
      const response = await this.makeRequest<SumitRecurringData>(
        SUMIT_ENDPOINTS.GET_RECURRING,
        {
          Credentials: buildCredentials(this.config),
          RecurringID: providerSubscriptionId,
        }
      );

      if (response.Status !== SUMIT_STATUS_OK || !response.Data) {
        return { success: false, error: mapSumitError(response) };
      }

      return {
        success: true,
        providerSubscriptionId,
        status: response.Data.Active === false ? 'canceled' : 'active',
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
      error: 'Standalone setup intents are not supported; use createSubscription.',
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
      // A structured SUMIT envelope (even an error one) proves reachability.
      await this.makeRequest(SUMIT_ENDPOINTS.GET_PAYMENT, {
        Credentials: buildCredentials(this.config),
        PaymentID: '__healthcheck__',
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

  // ==========================================================================
  // Helpers
  // ==========================================================================

  private async fetchPayment(
    paymentId: string
  ): Promise<{ success: boolean; data?: SumitPaymentData; error?: string }> {
    try {
      const response = await this.makeRequest<SumitPaymentData>(
        SUMIT_ENDPOINTS.GET_PAYMENT,
        {
          Credentials: buildCredentials(this.config),
          PaymentID: paymentId,
        }
      );
      if (response.Status !== SUMIT_STATUS_OK || !response.Data) {
        return { success: false, error: mapSumitError(response) };
      }
      return { success: true, data: response.Data };
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
