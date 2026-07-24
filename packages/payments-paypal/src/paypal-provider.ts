/**
 * PayPal (Orders v2) Payment Provider
 *
 * Implements IPaymentProvider for PayPal using the Orders v2 + Payments v2 REST
 * APIs. Every API call is verified against the official PayPal docs (the
 * verifying URL is cited next to each call and in paypal-types.ts).
 *
 * Design notes:
 * - Auth is OAuth2 client-credentials (Basic auth) with an in-memory token cache
 *   refreshed slightly before expiry.
 * - Checkout uses intent=CAPTURE: createPaymentIntent creates an order and
 *   returns the buyer-approval redirect link; verifyPayment (the PRIMARY
 *   confirmation path) GETs the order on return and CAPTURES it when approved.
 * - refund() is a REAL API refund of a capture (a genuine advantage over the
 *   SUMIT adapter, whose refund is a stub).
 * - Webhook signatures require an ASYNC postback to PayPal, which the sync
 *   IPaymentProvider.validateWebhookSignature cannot express; that method fails
 *   CLOSED and callers must use the async verifyWebhookSignature().
 *
 * The adapter never touches credits, plans, users or permissions — that logic
 * lives in the application's billing/domain layer.
 */

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
} from '@nehorai/payments/types';
import type {
  IPaymentProvider,
  SavePaymentMethodParams,
  SavePaymentMethodResult,
  DeletePaymentMethodResult,
  CreateSetupIntentParams,
  SetupIntentResult,
  CreateCustomerParams,
  CreateCustomerResult,
} from '@nehorai/payments/providers';
import {
  PaypalProviderConfigSchema,
  resolveBaseUrl,
  type PaypalProviderConfig,
} from './config.js';
import {
  PAYPAL_ENDPOINTS,
  PAYPAL_SUPPORTED_CURRENCIES,
  minorToDecimalString,
  decimalStringToMinor,
  mapOrderStatusToTransactionStatus,
  mapCaptureStatusToTransactionStatus,
  mapRefundStatus,
  mapPaypalError,
  type PaypalOrder,
  type PaypalCapture,
  type PaypalRefund,
  type PaypalTokenResponse,
  type PaypalCreateOrderRequest,
  type PaypalErrorResponse,
  type VerifyPaymentParams,
  type VerifyPaymentResult,
  type PaypalWebhookVerifyParams,
  type PaypalVerifyWebhookRequest,
  type PaypalVerifyWebhookResponse,
} from './paypal-types.js';

/** Refresh the access token this many ms BEFORE its stated expiry. */
const TOKEN_REFRESH_MARGIN_MS = 60_000;

interface TokenCache {
  token: string;
  /** Epoch ms at which the token should be considered expired. */
  expiresAt: number;
}

interface RawResult {
  ok: boolean;
  status: number;
  data: unknown;
}

export class PaypalProvider implements IPaymentProvider {
  readonly name: PaymentProvider = 'paypal';
  readonly supportedCurrencies = PAYPAL_SUPPORTED_CURRENCIES;
  readonly supportsRecurring = false;
  readonly supportsSplitPayments = false;

  private readonly config: PaypalProviderConfig;
  private readonly baseUrl: string;
  private tokenCache?: TokenCache;

  constructor(config: PaypalProviderConfig) {
    // Validate (and apply defaults) via the same zod schema the env path uses,
    // so a directly-constructed provider fails closed on missing secrets too.
    this.config = PaypalProviderConfigSchema.parse(config);
    this.baseUrl = resolveBaseUrl(this.config);
  }

  // ==========================================================================
  // OAuth2 access token (client-credentials) with early-refresh cache
  // Doc: https://developer.paypal.com/api/rest/authentication/
  // ==========================================================================

  private async getAccessToken(): Promise<string> {
    const now = Date.now();
    if (this.tokenCache && this.tokenCache.expiresAt - TOKEN_REFRESH_MARGIN_MS > now) {
      return this.tokenCache.token;
    }

    const basic = Buffer.from(
      `${this.config.clientId}:${this.config.clientSecret}`
    ).toString('base64');

    const response = await fetch(`${this.baseUrl}${PAYPAL_ENDPOINTS.OAUTH_TOKEN}`, {
      method: 'POST',
      headers: {
        // Basic auth with base64(client_id:client_secret) per the auth doc.
        Authorization: `Basic ${basic}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: 'grant_type=client_credentials',
    });

    if (!response.ok) {
      throw new Error(
        `PayPal OAuth token request failed: ${response.status} ${response.statusText}`
      );
    }

    const data = (await response.json()) as PaypalTokenResponse;
    if (!data.access_token) {
      throw new Error('PayPal OAuth response missing access_token');
    }

    this.tokenCache = {
      token: data.access_token,
      // expires_in is in seconds; cache until then (early refresh applied above).
      expiresAt: now + (data.expires_in ?? 0) * 1000,
    };
    return data.access_token;
  }

  // ==========================================================================
  // Checkout (one-time) — create order, return approval redirect
  // Doc: https://developer.paypal.com/docs/api/orders/v2/#orders_create
  // ==========================================================================

  async createPaymentIntent(
    params: CreatePaymentIntentParams
  ): Promise<PaymentIntentResult> {
    try {
      // Our internal order ref: prefer metadata.orderId, else the idempotency key.
      const internalOrderId =
        (params.metadata?.orderId as string | undefined) ?? params.idempotencyKey;
      const currency = params.amount.currency;
      const description = params.description ?? 'Payment';
      const cancelUrl = params.metadata?.cancelUrl as string | undefined;
      const brandName = params.metadata?.brandName as string | undefined;

      const request: PaypalCreateOrderRequest = {
        intent: 'CAPTURE',
        purchase_units: [
          {
            // reference_id + custom_id both carry our ref back on the capture.
            reference_id: internalOrderId,
            custom_id: internalOrderId,
            description,
            amount: {
              currency_code: currency,
              value: minorToDecimalString(params.amount.amountMinor, currency),
            },
          },
        ],
        // Redirect handoff URLs (verified application_context location).
        application_context: {
          return_url: params.returnUrl,
          cancel_url: cancelUrl,
          brand_name: brandName,
          user_action: 'PAY_NOW',
        },
      };

      // PayPal-Request-Id makes create-order idempotent.
      const result = await this.request('POST', PAYPAL_ENDPOINTS.CREATE_ORDER, {
        body: request,
        idempotencyKey: params.idempotencyKey,
      });

      if (!result.ok) {
        const err = result.data as PaypalErrorResponse;
        return {
          success: false,
          error: mapPaypalError(err, result.status),
          errorCode: err?.name ?? String(result.status),
        };
      }

      const order = result.data as PaypalOrder;
      // Buyer approval link: classic redirect is rel:"approve"; the newer
      // payment-source flow is rel:"payer-action". Accept either.
      const approvalUrl = order.links?.find(
        (l) => l.rel === 'approve' || l.rel === 'payer-action'
      )?.href;

      if (!order.id || !approvalUrl) {
        return {
          success: false,
          error: 'PayPal order created without an id or approval link',
        };
      }

      return {
        success: true,
        // The PayPal order id is the external ref the app keys on.
        providerIntentId: order.id,
        redirectUrl: approvalUrl,
        status: mapOrderStatusToTransactionStatus(order.status),
      };
    } catch (error) {
      return this.handleError(error);
    }
  }

  // ==========================================================================
  // verify-on-return (PRIMARY confirmation): GET order, capture if approved
  // Doc: https://developer.paypal.com/docs/api/orders/v2/#orders_get
  //      https://developer.paypal.com/docs/api/orders/v2/#orders_capture
  // ==========================================================================

  /**
   * Verify a returned PayPal order and capture it when it is approved but not
   * yet captured. `verified` is the single source of truth for granting.
   */
  async verifyPayment(params: VerifyPaymentParams): Promise<VerifyPaymentResult> {
    try {
      const getRes = await this.request(
        'GET',
        PAYPAL_ENDPOINTS.getOrder(params.orderId)
      );
      if (!getRes.ok) {
        return {
          verified: false,
          valid: false,
          externalRef: params.orderId,
          error: mapPaypalError(getRes.data as PaypalErrorResponse, getRes.status),
        };
      }

      let order = getRes.data as PaypalOrder;

      if (order.status === 'APPROVED') {
        // Approved but not captured → capture now (idempotent via order id).
        const capRes = await this.request(
          'POST',
          PAYPAL_ENDPOINTS.captureOrder(params.orderId),
          { idempotencyKey: params.orderId }
        );
        if (!capRes.ok) {
          return {
            verified: false,
            valid: false,
            externalRef: params.orderId,
            error: mapPaypalError(
              capRes.data as PaypalErrorResponse,
              capRes.status
            ),
          };
        }
        // The capture response is itself an order with the capture embedded.
        order = capRes.data as PaypalOrder;
      } else if (order.status !== 'COMPLETED') {
        // CREATED / SAVED / PAYER_ACTION_REQUIRED / VOIDED → not grantable.
        return {
          verified: false,
          valid: false,
          externalRef: params.orderId,
          order,
          error: `PayPal order status ${order.status ?? 'unknown'} is not capturable`,
        };
      }

      const capture: PaypalCapture | undefined =
        order.purchase_units?.[0]?.payments?.captures?.[0];
      const captureStatus = capture?.status;
      const valid = order.status === 'COMPLETED' && captureStatus === 'COMPLETED';

      const currency = capture?.amount?.currency_code;
      const amountMinor =
        capture?.amount && currency
          ? decimalStringToMinor(capture.amount.value, currency)
          : undefined;

      const amountMatches =
        params.expectedAmountMinor == null
          ? undefined
          : amountMinor === params.expectedAmountMinor;
      const verified =
        valid && (params.expectedAmountMinor == null || amountMatches === true);

      return {
        verified,
        valid,
        amountMatches,
        amountMinor,
        currency,
        externalRef: params.orderId,
        documentNumber: capture?.id,
        captureStatus,
        order,
      };
    } catch (error) {
      return {
        verified: false,
        valid: false,
        externalRef: params.orderId,
        error: error instanceof Error ? error.message : 'Verification failed',
      };
    }
  }

  /**
   * Authoritative order lookup (raw). Mirrors SUMIT's getPayment: returns the
   * raw PayPal order so the app can inspect status/amount/refs itself.
   */
  async getPayment(
    orderId: string
  ): Promise<{ success: boolean; order?: PaypalOrder; error?: string }> {
    try {
      const res = await this.request('GET', PAYPAL_ENDPOINTS.getOrder(orderId));
      if (!res.ok) {
        return {
          success: false,
          error: mapPaypalError(res.data as PaypalErrorResponse, res.status),
        };
      }
      return { success: true, order: res.data as PaypalOrder };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Lookup failed',
      };
    }
  }

  // ==========================================================================
  // Two-phase commit surface (PayPal intent=CAPTURE is effectively single-phase)
  // ==========================================================================

  /** GET the order and report whether the buyer has approved it. */
  async authorize(params: AuthorizePaymentParams): Promise<AuthorizationResult> {
    const res = await this.getPayment(params.providerIntentId);
    if (!res.success || !res.order) {
      return { success: false, error: res.error ?? 'Order not found' };
    }
    const status = res.order.status;
    if (status === 'APPROVED' || status === 'COMPLETED') {
      return {
        success: true,
        authorizationCode: res.order.id ?? params.providerIntentId,
        status: 'authorized',
      };
    }
    return {
      success: false,
      error: `Order not approved (status ${status ?? 'unknown'})`,
      status: 'pending_authorization',
    };
  }

  /**
   * Capture an approved order. A REAL capture call.
   * Doc: https://developer.paypal.com/docs/api/orders/v2/#orders_capture
   */
  async capture(params: CapturePaymentParams): Promise<CaptureResult> {
    try {
      const res = await this.request(
        'POST',
        PAYPAL_ENDPOINTS.captureOrder(params.providerIntentId),
        { idempotencyKey: params.idempotencyKey ?? params.providerIntentId }
      );
      if (!res.ok) {
        const err = res.data as PaypalErrorResponse;
        return {
          success: false,
          error: mapPaypalError(err, res.status),
          errorCode: err?.name ?? String(res.status),
        };
      }
      const order = res.data as PaypalOrder;
      const capture = order.purchase_units?.[0]?.payments?.captures?.[0];
      if (order.status !== 'COMPLETED' || capture?.status !== 'COMPLETED') {
        return {
          success: false,
          error: `Capture not completed (status ${capture?.status ?? order.status ?? 'unknown'})`,
        };
      }
      const currency = capture.amount?.currency_code;
      return {
        success: true,
        providerTransactionId: capture.id ?? order.id,
        status: 'captured',
        capturedAmount:
          capture.amount && currency
            ? {
                amountMinor: decimalStringToMinor(capture.amount.value, currency),
                currency,
              }
            : undefined,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Capture failed',
      };
    }
  }

  /**
   * Void is not applicable to an intent=CAPTURE order (void applies to AUTHORIZE
   * holds via /v2/payments/authorizations/{id}/void). An uncaptured CAPTURE order
   * simply expires; there is no void call for it.
   */
  async void(_params: VoidPaymentParams): Promise<VoidResult> {
    return {
      success: false,
      error:
        'Void is not supported for intent=CAPTURE orders; an uncaptured order expires automatically.',
    };
  }

  // ==========================================================================
  // Refund — REAL API refund of a capture
  // Doc: https://developer.paypal.com/docs/api/payments/v2/ (captures refund)
  // ==========================================================================

  async refund(params: RefundParams): Promise<RefundResult> {
    try {
      // providerTransactionId is the PayPal capture id.
      const body: Record<string, unknown> | undefined = params.amount
        ? {
            amount: {
              currency_code: params.amount.currency,
              value: minorToDecimalString(
                params.amount.amountMinor,
                params.amount.currency
              ),
            },
          }
        : undefined; // empty body ⇒ full refund

      const res = await this.request(
        'POST',
        PAYPAL_ENDPOINTS.refundCapture(params.providerTransactionId),
        { body, idempotencyKey: params.idempotencyKey }
      );

      if (!res.ok) {
        const err = res.data as PaypalErrorResponse;
        return {
          success: false,
          error: mapPaypalError(err, res.status),
        };
      }

      const refund = res.data as PaypalRefund;
      const status = mapRefundStatus(refund.status);
      const currency = refund.amount?.currency_code;
      return {
        success: status !== 'failed',
        providerRefundId: refund.id,
        refundedAmount:
          refund.amount && currency
            ? {
                amountMinor: decimalStringToMinor(refund.amount.value, currency),
                currency,
              }
            : undefined,
        status,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Refund failed',
      };
    }
  }

  // ==========================================================================
  // Payment methods & customers — hosted flow ⇒ minimal stubs (mirror SUMIT)
  // ==========================================================================

  async createSetupIntent(
    _params: CreateSetupIntentParams
  ): Promise<SetupIntentResult> {
    return {
      success: false,
      error: 'Standalone setup intents are not supported by the PayPal adapter.',
    };
  }

  async savePaymentMethod(
    _params: SavePaymentMethodParams
  ): Promise<SavePaymentMethodResult> {
    return {
      success: false,
      error: 'savePaymentMethod is not supported by the PayPal adapter.',
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
    // PayPal collects the buyer on the hosted approval page; we key on our userId.
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

  /** A successful OAuth token fetch proves credentials + reachability. */
  async getHealth(): Promise<ProviderHealthStatus> {
    const start = Date.now();
    try {
      await this.getAccessToken();
      return {
        provider: this.name,
        healthy: true,
        lastChecked: new Date(),
        avgLatencyMs: Date.now() - start,
        circuitBreakerOpen: false,
      };
    } catch {
      return {
        provider: this.name,
        healthy: false,
        lastChecked: new Date(),
        circuitBreakerOpen: false,
      };
    }
  }

  /**
   * IPaymentProvider requires a SYNC signature check, but PayPal verification is
   * an ASYNC postback needing five transmission headers + the webhook id — none
   * of which fit `(payload, signature)`. This therefore fails CLOSED; callers
   * MUST use {@link verifyWebhookSignature}. Returning false never accepts an
   * unverified webhook.
   */
  validateWebhookSignature(_payload: string, _signature: string): boolean {
    return false;
  }

  /**
   * REAL webhook signature verification via the postback endpoint.
   * Doc: https://developer.paypal.com/api/rest/webhooks/rest/
   * Returns true ONLY when PayPal reports verification_status === 'SUCCESS'.
   * Fails closed if the webhook id is not configured.
   */
  async verifyWebhookSignature(
    params: PaypalWebhookVerifyParams
  ): Promise<boolean> {
    if (!this.config.webhookId) {
      return false;
    }
    try {
      const body: PaypalVerifyWebhookRequest = {
        auth_algo: params.authAlgo,
        cert_url: params.certUrl,
        transmission_id: params.transmissionId,
        transmission_sig: params.transmissionSig,
        transmission_time: params.transmissionTime,
        webhook_id: this.config.webhookId,
        // Must be posted back EXACTLY as received.
        webhook_event: params.webhookEvent,
      };
      const res = await this.request(
        'POST',
        PAYPAL_ENDPOINTS.VERIFY_WEBHOOK_SIGNATURE,
        { body }
      );
      if (!res.ok) return false;
      return (
        (res.data as PaypalVerifyWebhookResponse).verification_status === 'SUCCESS'
      );
    } catch {
      return false;
    }
  }

  /** Map the current order status to a unified transaction status. */
  async getPaymentIntentStatus(
    providerIntentId: string
  ): Promise<{ status: string; error?: string }> {
    const res = await this.getPayment(providerIntentId);
    if (!res.success || !res.order) {
      return { status: 'unknown', error: res.error };
    }
    return { status: mapOrderStatusToTransactionStatus(res.order.status) };
  }

  // ==========================================================================
  // Helpers
  // ==========================================================================

  private async request(
    method: 'GET' | 'POST',
    path: string,
    options: { body?: unknown; idempotencyKey?: string } = {}
  ): Promise<RawResult> {
    const token = await this.getAccessToken();
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    };
    // PayPal-Request-Id gives idempotency on create-order / capture / refund.
    if (options.idempotencyKey) {
      headers['PayPal-Request-Id'] = options.idempotencyKey;
    }

    const response = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers,
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
    });

    // PayPal returns 200/201 with a body; 204 (no content) on some ops.
    const text = await response.text();
    const data = text ? JSON.parse(text) : {};
    return { ok: response.ok, status: response.status, data };
  }

  private handleError(error: unknown): { success: false; error: string } {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error occurred',
    };
  }
}
