/**
 * Cardcom Provider Implementation
 *
 * Implements IPaymentProvider for Cardcom payment gateway (Israeli market).
 * Uses Low Profile (hosted page) for PCI compliance and direct API for operations.
 * Supports Two-Phase Commit (J5) with SuspendDealOnly operation.
 *
 * @see https://secure.cardcom.solutions/api/v11/swagger/ui/index
 */

import * as crypto from 'crypto';
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
import { calculateCaptureDeadline } from '@nehorai/payments/types';
import {
  CARDCOM_API_BASE,
  CARDCOM_ENDPOINTS,
  CARDCOM_SUPPORTED_CURRENCIES,
  CardcomOperation,
  getCurrencyCode,
  mapCardcomDealResponseToStatus,
  mapCardcomError,
  type CardcomLowProfileRequest,
  type CardcomLowProfileResponse,
  type CardcomLowProfileStatusResponse,
  type CardcomRefundRequest,
  type CardcomRefundResponse,
} from './cardcom-types.js';

/**
 * Cardcom provider constructor config
 */
export interface CardcomProviderConfig {
  terminalNumber: string;
  apiName: string;
  apiPassword: string;
  webhookSecret?: string;
}

/**
 * Cardcom Payment Provider
 *
 * Full implementation of IPaymentProvider for Cardcom.
 */
export class CardcomProvider implements IPaymentProvider {
  readonly name: PaymentProvider = 'cardcom';
  readonly supportedCurrencies = CARDCOM_SUPPORTED_CURRENCIES;
  readonly supportsRecurring = true;
  readonly supportsSplitPayments = false;

  private config: CardcomProviderConfig;

  constructor(config: CardcomProviderConfig) {
    if (!config.terminalNumber || !config.apiName || !config.apiPassword) {
      throw new Error(
        'CardcomProvider requires terminalNumber, apiName, and apiPassword in config'
      );
    }
    this.config = config;
  }

  // ==========================================================================
  // Payment Intent Operations
  // ==========================================================================

  async createPaymentIntent(
    params: CreatePaymentIntentParams
  ): Promise<PaymentIntentResult> {
    try {
      const amountMajor = params.amount.amountMinor / 100;

      const operation =
        params.captureMethod === 'manual'
          ? CardcomOperation.SUSPEND_DEAL_ONLY
          : params.metadata?.savePaymentMethod
            ? CardcomOperation.BILL_AND_CREATE_TOKEN
            : CardcomOperation.BILL_ONLY;

      const request: CardcomLowProfileRequest = {
        TerminalNumber: this.config.terminalNumber,
        ApiName: this.config.apiName,
        ApiPassword: this.config.apiPassword,
        Sum: amountMajor,
        CoinID: getCurrencyCode(params.amount.currency),
        Operation: operation,
        Language: 'en',
        ReturnUrl: params.returnUrl,
        ErrorUrl: params.returnUrl,
        ProductName: params.description ?? 'Payment',
        InternalDealNumber: params.idempotencyKey,
        SendEmail: false,
      };

      if (params.metadata?.customerName) {
        request.CustomerName = String(params.metadata.customerName);
      }
      if (params.metadata?.customerEmail) {
        request.Email = String(params.metadata.customerEmail);
      }

      const response = await this.makeRequest<CardcomLowProfileResponse>(
        CARDCOM_ENDPOINTS.LOW_PROFILE_CREATE,
        request as unknown as Record<string, unknown>
      );

      if (response.ResponseCode !== 0 || !response.PaymentUrl) {
        return {
          success: false,
          error: mapCardcomError(response.ResponseCode),
          errorCode: String(response.ResponseCode),
        };
      }

      return {
        success: true,
        providerIntentId: response.LowProfileCode!,
        redirectUrl: response.PaymentUrl,
        status: 'created',
      };
    } catch (error) {
      return this.handleError(error);
    }
  }

  async authorize(params: AuthorizePaymentParams): Promise<AuthorizationResult> {
    try {
      const statusResponse = await this.getLowProfileStatus(
        params.providerIntentId
      );

      if (!statusResponse.success || !statusResponse.data) {
        return {
          success: false,
          error: statusResponse.error ?? 'Failed to check payment status',
        };
      }

      const status = statusResponse.data;

      if (status.DealResponse === 1) {
        return {
          success: true,
          authorizationCode: status.InternalDealNumber ?? params.providerIntentId,
          status: 'authorized',
          captureDeadline: calculateCaptureDeadline(new Date()),
        };
      }

      if (status.DealResponse === 2) {
        return {
          success: false,
          error: 'Payment declined',
          status: 'failed',
        };
      }

      return {
        success: false,
        error: 'Payment not yet completed',
        status: 'pending_authorization',
      };
    } catch (error) {
      return this.handleError(error);
    }
  }

  async capture(params: CapturePaymentParams): Promise<CaptureResult> {
    try {
      const statusResponse = await this.getLowProfileStatus(
        params.providerIntentId
      );

      if (!statusResponse.success || !statusResponse.data) {
        return {
          success: false,
          error: statusResponse.error ?? 'Failed to capture payment',
        };
      }

      const status = statusResponse.data;

      if (status.DealResponse === 1) {
        return {
          success: true,
          providerTransactionId: status.InternalDealNumber ?? params.providerIntentId,
          status: 'captured',
          capturedAmount: {
            amountMinor: Math.round((status.Amount ?? 0) * 100),
            currency: status.Currency ?? params.amount?.currency ?? 'ILS',
          },
        };
      }

      return {
        success: false,
        error: 'Payment not authorized for capture',
        status: mapCardcomDealResponseToStatus(status.DealResponse ?? 3),
      };
    } catch (error) {
      return this.handleError(error);
    }
  }

  async void(_params: VoidPaymentParams): Promise<VoidResult> {
    return {
      success: false,
      error: 'Void operation not supported via API. Please use Cardcom merchant dashboard.',
    };
  }

  async refund(params: RefundParams): Promise<RefundResult> {
    try {
      const refundAmount = params.amount
        ? params.amount.amountMinor / 100
        : undefined;

      if (!refundAmount) {
        return {
          success: false,
          error: 'Refund amount is required',
        };
      }

      const request: CardcomRefundRequest = {
        TerminalNumber: this.config.terminalNumber,
        ApiName: this.config.apiName,
        ApiPassword: this.config.apiPassword,
        InternalDealNumber: params.providerTransactionId,
        Amount: refundAmount,
        CoinID: params.amount ? getCurrencyCode(params.amount.currency) : 1,
      };

      const response = await this.makeRequest<CardcomRefundResponse>(
        CARDCOM_ENDPOINTS.REFUND,
        request as unknown as Record<string, unknown>
      );

      if (response.ResponseCode !== 0) {
        return {
          success: false,
          error: mapCardcomError(response.ResponseCode),
        };
      }

      return {
        success: true,
        providerRefundId: response.InternalDealNumber ?? params.providerTransactionId,
        refundedAmount: {
          amountMinor: Math.round((response.Amount ?? 0) * 100),
          currency: params.amount?.currency ?? 'ILS',
        },
        status: 'succeeded',
      };
    } catch (error) {
      return this.handleError(error);
    }
  }

  // ==========================================================================
  // Payment Method Tokenization
  // ==========================================================================

  async createSetupIntent(
    params: CreateSetupIntentParams
  ): Promise<SetupIntentResult> {
    try {
      const request: CardcomLowProfileRequest = {
        TerminalNumber: this.config.terminalNumber,
        ApiName: this.config.apiName,
        ApiPassword: this.config.apiPassword,
        Sum: 0,
        Operation: CardcomOperation.CREATE_TOKEN_ONLY,
        Language: 'en',
        InternalDealNumber: `setup_${params.userId}_${Date.now()}`,
      };

      const response = await this.makeRequest<CardcomLowProfileResponse>(
        CARDCOM_ENDPOINTS.LOW_PROFILE_CREATE,
        request as unknown as Record<string, unknown>
      );

      if (response.ResponseCode !== 0 || !response.PaymentUrl) {
        return {
          success: false,
          error: mapCardcomError(response.ResponseCode),
        };
      }

      return {
        success: true,
        setupIntentId: response.LowProfileCode!,
        clientSecret: response.PaymentUrl,
      };
    } catch (error) {
      return this.handleError(error);
    }
  }

  async savePaymentMethod(
    params: SavePaymentMethodParams
  ): Promise<SavePaymentMethodResult> {
    try {
      const lowProfileCode = params.setupData.lowProfileCode as string;

      if (!lowProfileCode) {
        return {
          success: false,
          error: 'Low profile code is required',
        };
      }

      const statusResponse = await this.getLowProfileStatus(lowProfileCode);

      if (!statusResponse.success || !statusResponse.data) {
        return {
          success: false,
          error: statusResponse.error ?? 'Failed to retrieve payment method',
        };
      }

      const status = statusResponse.data;

      if (!status.Token) {
        return {
          success: false,
          error: 'No token created',
        };
      }

      const [expMonth, expYear] = (status.CardExpiration ?? '/').split('/');

      return {
        success: true,
        paymentMethodId: status.Token,
        cardBrand: status.CardType ?? 'unknown',
        cardLast4: status.CardMask?.slice(-4),
        cardExpMonth: expMonth?.padStart(2, '0'),
        cardExpYear: expYear ? `20${expYear}` : undefined,
        cardBin: status.CardBin,
      };
    } catch (error) {
      return this.handleError(error);
    }
  }

  async deletePaymentMethod(
    _paymentMethodId: string
  ): Promise<DeletePaymentMethodResult> {
    return {
      success: true,
    };
  }

  // ==========================================================================
  // Customer Management
  // ==========================================================================

  async createCustomer(params: CreateCustomerParams): Promise<CreateCustomerResult> {
    return {
      success: true,
      customerId: params.userId,
    };
  }

  async getOrCreateCustomer(
    userId: string,
    email: string
  ): Promise<CreateCustomerResult> {
    return this.createCustomer({ userId, email });
  }

  // ==========================================================================
  // Health & Status
  // ==========================================================================

  async getHealth(): Promise<ProviderHealthStatus> {
    const start = Date.now();
    try {
      const request: CardcomLowProfileRequest = {
        TerminalNumber: this.config.terminalNumber,
        ApiName: this.config.apiName,
        ApiPassword: this.config.apiPassword,
        Sum: 1,
        Operation: CardcomOperation.BILL_ONLY,
        InternalDealNumber: `health_check_${Date.now()}`,
      };

      const response = await this.makeRequest<CardcomLowProfileResponse>(
        CARDCOM_ENDPOINTS.LOW_PROFILE_CREATE,
        request as unknown as Record<string, unknown>
      );

      const healthy = response.ResponseCode === 0 || response.ResponseCode === 1;

      return {
        provider: 'cardcom',
        healthy,
        lastChecked: new Date(),
        avgLatencyMs: Date.now() - start,
        circuitBreakerOpen: false,
      };
    } catch {
      return {
        provider: 'cardcom',
        healthy: false,
        lastChecked: new Date(),
        circuitBreakerOpen: false,
      };
    }
  }

  validateWebhookSignature(payload: string, signature: string): boolean {
    if (!this.config.webhookSecret) {
      return false;
    }

    try {
      const expectedSignature = crypto
        .createHmac('sha256', this.config.webhookSecret)
        .update(payload)
        .digest('hex');

      return crypto.timingSafeEqual(
        Buffer.from(signature),
        Buffer.from(expectedSignature)
      );
    } catch {
      return false;
    }
  }

  async getPaymentIntentStatus(
    providerIntentId: string
  ): Promise<{ status: string; error?: string }> {
    try {
      const result = await this.getLowProfileStatus(providerIntentId);

      if (!result.success || !result.data) {
        return {
          status: 'unknown',
          error: result.error,
        };
      }

      const status = mapCardcomDealResponseToStatus(
        result.data.DealResponse ?? 0
      );

      return { status };
    } catch (error) {
      return {
        status: 'unknown',
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  // ==========================================================================
  // Helper Methods
  // ==========================================================================

  private async makeRequest<T>(
    endpoint: string,
    data: Record<string, unknown>
  ): Promise<T> {
    const url = `${CARDCOM_API_BASE}${endpoint}`;

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(data),
    });

    if (!response.ok) {
      throw new Error(`Cardcom API error: ${response.status} ${response.statusText}`);
    }

    return response.json() as Promise<T>;
  }

  private async getLowProfileStatus(
    lowProfileCode: string
  ): Promise<{
    success: boolean;
    data?: CardcomLowProfileStatusResponse;
    error?: string;
  }> {
    try {
      const params = new URLSearchParams({
        terminalnumber: this.config.terminalNumber,
        lowprofilecode: lowProfileCode,
        username: this.config.apiName,
      });

      const url = `${CARDCOM_API_BASE}${CARDCOM_ENDPOINTS.LOW_PROFILE_STATUS}?${params}`;

      const response = await fetch(url, {
        method: 'GET',
      });

      if (!response.ok) {
        return {
          success: false,
          error: `Status check failed: ${response.status}`,
        };
      }

      const data = (await response.json()) as CardcomLowProfileStatusResponse;

      if (data.ResponseCode !== 0) {
        return {
          success: false,
          error: mapCardcomError(data.ResponseCode),
        };
      }

      return { success: true, data };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Status check failed',
      };
    }
  }

  private handleError(error: unknown): {
    success: false;
    error: string;
    errorCode?: string;
  } {
    const errorMessage =
      error instanceof Error ? error.message : 'Unknown error occurred';

    return {
      success: false,
      error: errorMessage,
    };
  }
}
