/**
 * @nehorai/payments-stripe - Stripe Provider Implementation
 *
 * Implements IPaymentProvider for Stripe payment processing.
 * Supports Two-Phase Commit (J5) with manual capture.
 *
 * @see https://docs.stripe.com/api
 */

import Stripe from 'stripe';
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
import type { StripeConfig } from './stripe-types.js';
import {
  mapStripeStatus,
  mapStripeError,
  STRIPE_SUPPORTED_CURRENCIES,
  DEFAULT_STRIPE_API_VERSION,
} from './stripe-types.js';

const DEFAULT_AUTH_HOLD_DAYS = 7;

function calculateCaptureDeadline(
  authorizedAt: Date,
  holdDays: number = DEFAULT_AUTH_HOLD_DAYS
): Date {
  const deadline = new Date(authorizedAt);
  deadline.setDate(deadline.getDate() + holdDays);
  return deadline;
}

/**
 * Stripe Payment Provider
 *
 * Full implementation of IPaymentProvider for Stripe.
 * Accepts configuration via constructor parameter (no env reads).
 */
export class StripeProvider implements IPaymentProvider {
  readonly name: PaymentProvider = 'stripe';
  readonly supportedCurrencies = STRIPE_SUPPORTED_CURRENCIES;
  readonly supportsRecurring = true;
  readonly supportsSplitPayments = true;

  private stripe: Stripe;
  private webhookSecret: string | undefined;

  constructor(config: StripeConfig) {
    if (!config.secretKey) {
      throw new Error('secretKey is required for StripeProvider');
    }

    this.stripe = new Stripe(config.secretKey, {
      apiVersion: (config.apiVersion ?? DEFAULT_STRIPE_API_VERSION) as Stripe.LatestApiVersion,
      typescript: true,
    });

    this.webhookSecret = config.webhookSecret;
  }

  async createPaymentIntent(
    params: CreatePaymentIntentParams
  ): Promise<PaymentIntentResult> {
    try {
      const paymentIntent = await this.stripe.paymentIntents.create({
        amount: params.amount.amountMinor,
        currency: params.amount.currency.toLowerCase(),
        capture_method: params.captureMethod ?? 'manual',
        metadata: {
          userId: params.userId,
          idempotencyKey: params.idempotencyKey,
          ...this.flattenMetadata(params.metadata),
        },
        description: params.description,
        ...(params.paymentMethodId && {
          payment_method: params.paymentMethodId,
          confirm: true,
          return_url: params.returnUrl,
        }),
      }, {
        idempotencyKey: params.idempotencyKey,
      });

      return {
        success: true,
        providerIntentId: paymentIntent.id,
        clientSecret: paymentIntent.client_secret ?? undefined,
        status: mapStripeStatus(paymentIntent.status) ?? 'created',
      };
    } catch (error) {
      return this.handleStripeError(error);
    }
  }

  async authorize(params: AuthorizePaymentParams): Promise<AuthorizationResult> {
    try {
      const paymentIntent = await this.stripe.paymentIntents.retrieve(
        params.providerIntentId
      );

      if (paymentIntent.status === 'requires_capture') {
        return {
          success: true,
          authorizationCode: paymentIntent.id,
          status: 'authorized',
          captureDeadline: calculateCaptureDeadline(new Date()),
        };
      }

      return {
        success: false,
        error: `Payment not authorized. Status: ${paymentIntent.status}`,
        status: mapStripeStatus(paymentIntent.status) ?? undefined,
      };
    } catch (error) {
      return this.handleStripeError(error);
    }
  }

  async capture(params: CapturePaymentParams): Promise<CaptureResult> {
    try {
      const captured = await this.stripe.paymentIntents.capture(
        params.providerIntentId,
        {
          ...(params.amount && {
            amount_to_capture: params.amount.amountMinor,
          }),
        },
        {
          idempotencyKey: params.idempotencyKey,
        }
      );

      return {
        success: true,
        providerTransactionId: captured.latest_charge as string,
        status: 'captured',
        capturedAmount: {
          amountMinor: captured.amount_received,
          currency: captured.currency.toUpperCase(),
        },
      };
    } catch (error) {
      return this.handleStripeError(error);
    }
  }

  async void(params: VoidPaymentParams): Promise<VoidResult> {
    try {
      await this.stripe.paymentIntents.cancel(params.providerIntentId, {
        cancellation_reason: 'requested_by_customer',
      });
      return { success: true, status: 'voided' };
    } catch (error) {
      return this.handleStripeError(error);
    }
  }

  async refund(params: RefundParams): Promise<RefundResult> {
    try {
      const refund = await this.stripe.refunds.create({
        charge: params.providerTransactionId,
        ...(params.amount && { amount: params.amount.amountMinor }),
        reason: params.reason as Stripe.RefundCreateParams.Reason ?? 'requested_by_customer',
      }, {
        idempotencyKey: params.idempotencyKey,
      });

      return {
        success: true,
        providerRefundId: refund.id,
        refundedAmount: {
          amountMinor: refund.amount,
          currency: refund.currency.toUpperCase(),
        },
        status: refund.status === 'succeeded' ? 'succeeded' : 'pending',
      };
    } catch (error) {
      return this.handleStripeError(error);
    }
  }

  async createSetupIntent(
    params: CreateSetupIntentParams
  ): Promise<SetupIntentResult> {
    try {
      const setupIntent = await this.stripe.setupIntents.create({
        customer: params.customerId,
        metadata: { userId: params.userId },
        usage: 'off_session',
      });
      return {
        success: true,
        setupIntentId: setupIntent.id,
        clientSecret: setupIntent.client_secret ?? undefined,
      };
    } catch (error) {
      return this.handleStripeError(error);
    }
  }

  async savePaymentMethod(
    params: SavePaymentMethodParams
  ): Promise<SavePaymentMethodResult> {
    try {
      const setupIntentId = params.setupData.setupIntentId as string;
      const si = await this.stripe.setupIntents.retrieve(setupIntentId, {
        expand: ['payment_method'],
      });
      if (si.status !== 'succeeded') {
        return { success: false, error: `Status: ${si.status}` };
      }
      const pm = si.payment_method as Stripe.PaymentMethod;
      if (!pm?.card) return { success: false, error: 'Invalid payment method' };
      return {
        success: true,
        paymentMethodId: pm.id,
        cardBrand: pm.card.brand,
        cardLast4: pm.card.last4,
        cardExpMonth: String(pm.card.exp_month).padStart(2, '0'),
        cardExpYear: String(pm.card.exp_year),
      };
    } catch (error) {
      return this.handleStripeError(error);
    }
  }

  async deletePaymentMethod(pmId: string): Promise<DeletePaymentMethodResult> {
    try {
      await this.stripe.paymentMethods.detach(pmId);
      return { success: true };
    } catch (error) {
      return this.handleStripeError(error);
    }
  }

  async createCustomer(
    params: CreateCustomerParams
  ): Promise<CreateCustomerResult> {
    try {
      const customer = await this.stripe.customers.create({
        email: params.email,
        name: params.name,
        metadata: { userId: params.userId, ...params.metadata },
      });
      return { success: true, customerId: customer.id };
    } catch (error) {
      return this.handleStripeError(error);
    }
  }

  async getOrCreateCustomer(
    userId: string,
    email: string
  ): Promise<CreateCustomerResult> {
    try {
      const list = await this.stripe.customers.search({
        query: `metadata['userId']:'${userId}'`,
        limit: 1,
      });
      if (list.data.length > 0) {
        return { success: true, customerId: list.data[0].id };
      }
      return this.createCustomer({ userId, email });
    } catch (error) {
      return this.handleStripeError(error);
    }
  }

  async getHealth(): Promise<ProviderHealthStatus> {
    const start = Date.now();
    try {
      await this.stripe.balance.retrieve();
      return {
        provider: 'stripe',
        healthy: true,
        lastChecked: new Date(),
        avgLatencyMs: Date.now() - start,
        circuitBreakerOpen: false,
      };
    } catch {
      return {
        provider: 'stripe',
        healthy: false,
        lastChecked: new Date(),
        circuitBreakerOpen: false,
      };
    }
  }

  validateWebhookSignature(payload: string, signature: string): boolean {
    if (!this.webhookSecret) return false;
    try {
      this.stripe.webhooks.constructEvent(
        payload,
        signature,
        this.webhookSecret
      );
      return true;
    } catch {
      return false;
    }
  }

  async getPaymentIntentStatus(
    id: string
  ): Promise<{ status: string; error?: string }> {
    try {
      const pi = await this.stripe.paymentIntents.retrieve(id);
      return { status: pi.status };
    } catch (e) {
      return {
        status: 'unknown',
        error: e instanceof Error ? e.message : 'Unknown',
      };
    }
  }

  private handleStripeError(error: unknown): {
    success: false;
    error: string;
    errorCode?: string;
  } {
    if (error instanceof Stripe.errors.StripeError) {
      return {
        success: false,
        error: error.message,
        errorCode: mapStripeError(error.code ?? 'unknown'),
      };
    }
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }

  private flattenMetadata(
    meta?: Record<string, unknown>
  ): Record<string, string> {
    if (!meta) return {};
    const result: Record<string, string> = {};
    for (const [k, v] of Object.entries(meta)) {
      if (v !== undefined && v !== null) result[k] = String(v);
    }
    return result;
  }
}
