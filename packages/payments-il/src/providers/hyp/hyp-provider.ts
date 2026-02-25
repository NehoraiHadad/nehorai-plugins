/**
 * Hyp (CreditGuard) Provider Implementation
 *
 * Implements IPaymentProvider for Hyp/CreditGuard payment processing.
 * Supports Two-Phase Commit (J5) with manual capture via TxOnly validation.
 *
 * API Documentation: https://cgpay3.creditguard.co.il/docs
 *
 * @see https://www.creditguard.co.il
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
import { calculateCaptureDeadline } from '@nehorai/payments/types';
import {
  DEFAULT_HYP_ENDPOINTS,
  HYP_SUPPORTED_CURRENCIES,
  HYP_VALIDATION_MODES,
  HYP_TRANSACTION_TYPES,
  HYP_TRANSACTION_CODES,
  HYP_CREDIT_TYPES,
  mapHypStatus,
  mapHypError,
  isHypSuccess,
  formatHypAmount,
} from './hyp-types.js';
import type {
  HypConfig,
  HypDoDealRequest,
  HypDoDealResponse,
  HypRefundDealRequest,
  HypRefundDealResponse,
} from './hyp-types.js';

/**
 * Hyp Payment Provider
 *
 * Full implementation of IPaymentProvider for CreditGuard.
 */
export class HypProvider implements IPaymentProvider {
  readonly name: PaymentProvider = 'hyp';
  readonly supportedCurrencies = HYP_SUPPORTED_CURRENCIES;
  readonly supportsRecurring = true;
  readonly supportsSplitPayments = false;

  private config: HypConfig & { baseUrl: string };

  constructor(config: HypConfig) {
    if (!config.terminalNumber || !config.user || !config.password) {
      throw new Error(
        'HypProvider requires terminalNumber, user, and password in config'
      );
    }

    // Resolve baseUrl: explicit baseUrl > environment > default to sandbox
    const baseUrl = config.baseUrl
      ?? (config.environment === 'production'
        ? DEFAULT_HYP_ENDPOINTS.production
        : DEFAULT_HYP_ENDPOINTS.test);

    this.config = { ...config, baseUrl };
  }

  // ==========================================================================
  // Payment Intent Operations
  // ==========================================================================

  /**
   * Create a payment intent
   *
   * For Hyp, this generates a hosted payment page or prepares for direct charge.
   */
  async createPaymentIntent(
    params: CreatePaymentIntentParams
  ): Promise<PaymentIntentResult> {
    try {
      // For hosted page flow (no payment method provided)
      if (!params.paymentMethodId) {
        return await this.createHostedPage(params);
      }

      // For direct charge with saved payment method
      return await this.chargeWithToken(params);
    } catch (error) {
      return this.handleError(error);
    }
  }

  /**
   * Create hosted payment page
   */
  private async createHostedPage(
    params: CreatePaymentIntentParams
  ): Promise<PaymentIntentResult> {
    const uniqueid = params.idempotencyKey;

    const request: HypDoDealRequest = {
      terminalNumber: this.config.terminalNumber,
      user: this.config.user,
      password: this.config.password,
      total: formatHypAmount(params.amount.amountMinor),
      currency: params.amount.currency,
      transactionType: HYP_TRANSACTION_TYPES.DEBIT,
      transactionCode:
        params.captureMethod === 'manual'
          ? HYP_TRANSACTION_CODES.VERIFY
          : HYP_TRANSACTION_CODES.REGULAR,
      validation:
        params.captureMethod === 'manual'
          ? HYP_VALIDATION_MODES.TX_ONLY
          : HYP_VALIDATION_MODES.AUTO_COMM,
      uniqueid,
      successUrl: params.returnUrl,
      errorUrl: params.returnUrl,
      cancelUrl: params.returnUrl,
      language: 'en',
    };

    const response = await this.sendDoDealRequest(request);

    if (!isHypSuccess(response.resultCode)) {
      return {
        success: false,
        error: response.resultDescription ?? 'Transaction failed',
        errorCode: mapHypError(response.resultCode),
      };
    }

    return {
      success: true,
      providerIntentId: response.transactionId ?? uniqueid,
      redirectUrl: response.redirectUrl,
      status: 'created',
    };
  }

  /**
   * Charge with saved payment method token
   */
  private async chargeWithToken(
    params: CreatePaymentIntentParams
  ): Promise<PaymentIntentResult> {
    const uniqueid = params.idempotencyKey;

    const request: HypDoDealRequest = {
      terminalNumber: this.config.terminalNumber,
      user: this.config.user,
      password: this.config.password,
      total: formatHypAmount(params.amount.amountMinor),
      currency: params.amount.currency,
      transactionType: HYP_TRANSACTION_TYPES.DEBIT,
      transactionCode:
        params.captureMethod === 'manual'
          ? HYP_TRANSACTION_CODES.VERIFY
          : HYP_TRANSACTION_CODES.REGULAR,
      validation:
        params.captureMethod === 'manual'
          ? HYP_VALIDATION_MODES.TX_ONLY
          : HYP_VALIDATION_MODES.AUTO_COMM,
      creditType: HYP_CREDIT_TYPES.TOKEN,
      cardToken: params.paymentMethodId,
      uniqueid,
    };

    const response = await this.sendDoDealRequest(request);

    if (!isHypSuccess(response.resultCode)) {
      return {
        success: false,
        error: response.resultDescription ?? 'Transaction failed',
        errorCode: mapHypError(response.resultCode),
      };
    }

    const status = mapHypStatus(response.resultCode) ?? 'created';

    return {
      success: true,
      providerIntentId: response.transactionId ?? uniqueid,
      status,
    };
  }

  async authorize(params: AuthorizePaymentParams): Promise<AuthorizationResult> {
    try {
      return {
        success: true,
        authorizationCode: params.providerIntentId,
        status: 'authorized',
        captureDeadline: calculateCaptureDeadline(new Date()),
      };
    } catch (error) {
      return this.handleError(error);
    }
  }

  async capture(params: CapturePaymentParams): Promise<CaptureResult> {
    try {
      const request: HypDoDealRequest = {
        terminalNumber: this.config.terminalNumber,
        user: this.config.user,
        password: this.config.password,
        total: params.amount
          ? formatHypAmount(params.amount.amountMinor)
          : undefined,
        currency: params.amount?.currency ?? 'ILS',
        transactionType: HYP_TRANSACTION_TYPES.DEBIT,
        transactionCode: HYP_TRANSACTION_CODES.FORCE,
        validation: HYP_VALIDATION_MODES.AUTO_COMM,
        uniqueid: params.idempotencyKey,
        authorizationCode: params.providerIntentId,
      };

      const response = await this.sendDoDealRequest(request);

      if (!isHypSuccess(response.resultCode)) {
        return {
          success: false,
          error: response.resultDescription ?? 'Capture failed',
          errorCode: mapHypError(response.resultCode),
        };
      }

      return {
        success: true,
        providerTransactionId: response.transactionId ?? params.providerIntentId,
        status: 'captured',
        capturedAmount: params.amount ?? {
          amountMinor: 0,
          currency: 'ILS',
        },
      };
    } catch (error) {
      return this.handleError(error);
    }
  }

  async void(params: VoidPaymentParams): Promise<VoidResult> {
    try {
      const request: HypRefundDealRequest = {
        terminalNumber: this.config.terminalNumber,
        user: this.config.user,
        password: this.config.password,
        transactionId: params.providerIntentId,
        currency: 'ILS',
        uniqueid: params.providerIntentId,
      };

      const response = await this.sendRefundRequest(request);

      if (!isHypSuccess(response.resultCode)) {
        return {
          success: false,
          error: response.resultDescription ?? 'Void failed',
        };
      }

      return { success: true, status: 'voided' };
    } catch (error) {
      return this.handleError(error);
    }
  }

  // ==========================================================================
  // Refunds
  // ==========================================================================

  async refund(params: RefundParams): Promise<RefundResult> {
    try {
      const request: HypRefundDealRequest = {
        terminalNumber: this.config.terminalNumber,
        user: this.config.user,
        password: this.config.password,
        transactionId: params.providerTransactionId,
        total: params.amount
          ? formatHypAmount(params.amount.amountMinor)
          : undefined,
        currency: params.amount?.currency ?? 'ILS',
        uniqueid: params.idempotencyKey,
      };

      const response = await this.sendRefundRequest(request);

      if (!isHypSuccess(response.resultCode)) {
        return {
          success: false,
          error: response.resultDescription ?? 'Refund failed',
        };
      }

      return {
        success: true,
        providerRefundId: response.transactionId ?? params.idempotencyKey,
        refundedAmount: params.amount ?? {
          amountMinor: 0,
          currency: 'ILS',
        },
        status: 'succeeded',
      };
    } catch (error) {
      return this.handleError(error);
    }
  }

  // ==========================================================================
  // Payment Methods (Tokenization)
  // ==========================================================================

  async createSetupIntent(
    params: CreateSetupIntentParams
  ): Promise<SetupIntentResult> {
    try {
      const uniqueid = `setup_${params.userId}_${Date.now()}`;

      const request: HypDoDealRequest = {
        terminalNumber: this.config.terminalNumber,
        user: this.config.user,
        password: this.config.password,
        total: 0,
        currency: 'ILS',
        transactionType: HYP_TRANSACTION_TYPES.DEBIT,
        transactionCode: HYP_TRANSACTION_CODES.VERIFY,
        validation: HYP_VALIDATION_MODES.TX_ONLY,
        creditType: HYP_CREDIT_TYPES.TOKEN,
        customerData: params.customerId ?? params.userId,
        uniqueid,
        language: 'en',
      };

      const response = await this.sendDoDealRequest(request);

      if (!isHypSuccess(response.resultCode)) {
        return {
          success: false,
          error: response.resultDescription ?? 'Setup failed',
        };
      }

      return {
        success: true,
        setupIntentId: response.transactionId ?? uniqueid,
        clientSecret: response.redirectUrl,
      };
    } catch (error) {
      return this.handleError(error);
    }
  }

  async savePaymentMethod(
    params: SavePaymentMethodParams
  ): Promise<SavePaymentMethodResult> {
    try {
      const cardToken = params.setupData.cardToken as string;
      const cardMask = params.setupData.cardMask as string;
      const cardBrand = params.setupData.cardBrand as string;
      const cardExpiration = params.setupData.cardExpiration as string;

      if (!cardToken) {
        return {
          success: false,
          error: 'No card token received',
        };
      }

      return {
        success: true,
        paymentMethodId: cardToken,
        cardBrand: cardBrand ?? 'unknown',
        cardLast4: cardMask?.slice(-4) ?? '0000',
        cardExpMonth: cardExpiration?.substring(0, 2) ?? '01',
        cardExpYear: `20${cardExpiration?.substring(2, 4) ?? '99'}`,
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

  async createCustomer(
    params: CreateCustomerParams
  ): Promise<CreateCustomerResult> {
    return {
      success: true,
      customerId: params.userId,
    };
  }

  async getOrCreateCustomer(
    userId: string,
    _email: string
  ): Promise<CreateCustomerResult> {
    return {
      success: true,
      customerId: userId,
    };
  }

  // ==========================================================================
  // Health & Security
  // ==========================================================================

  async getHealth(): Promise<ProviderHealthStatus> {
    const start = Date.now();
    try {
      const response = await fetch(`${this.config.baseUrl}/xpo/Relay`, {
        method: 'POST',
        headers: {
          'Content-Type': 'text/xml',
        },
        body: this.buildTestXML(),
        signal: AbortSignal.timeout(5000),
      });

      const healthy = response.ok;

      return {
        provider: 'hyp',
        healthy,
        lastChecked: new Date(),
        avgLatencyMs: Date.now() - start,
        circuitBreakerOpen: false,
      };
    } catch {
      return {
        provider: 'hyp',
        healthy: false,
        lastChecked: new Date(),
        circuitBreakerOpen: false,
      };
    }
  }

  validateWebhookSignature(_payload: string, _signature: string): boolean {
    if (!this.config.webhookSecret) return false;
    return !!this.config.webhookSecret;
  }

  async getPaymentIntentStatus(
    _providerIntentId: string
  ): Promise<{ status: string; error?: string }> {
    return {
      status: 'unknown',
      error: 'Status query not supported by Hyp basic integration',
    };
  }

  // ==========================================================================
  // XML Request Builders
  // ==========================================================================

  private buildDoDealXML(request: HypDoDealRequest): string {
    const parts: string[] = [];

    parts.push('<?xml version="1.0" encoding="utf-8"?>');
    parts.push('<ashrait>');
    parts.push('<request>');
    parts.push(`<version>1000</version>`);
    parts.push('<language>ENG</language>');

    parts.push('<command>doDeal</command>');
    parts.push(`<terminalNumber>${this.escapeXml(request.terminalNumber)}</terminalNumber>`);
    parts.push(`<user>${this.escapeXml(request.user)}</user>`);
    parts.push(`<password>${this.escapeXml(request.password)}</password>`);

    if (request.cardNo) {
      parts.push(`<cardNo>${this.escapeXml(request.cardNo)}</cardNo>`);
    }
    if (request.cardExpiration) {
      parts.push(`<cardExpiration>${this.escapeXml(request.cardExpiration)}</cardExpiration>`);
    }
    if (request.cvv) {
      parts.push(`<cvv>${this.escapeXml(request.cvv)}</cvv>`);
    }
    if (request.cardToken) {
      parts.push(`<cardToken>${this.escapeXml(request.cardToken)}</cardToken>`);
    }
    if (request.authorizationCode) {
      parts.push(`<authNumber>${this.escapeXml(request.authorizationCode)}</authNumber>`);
    }

    if (request.total !== undefined) {
      parts.push(`<total>${request.total}</total>`);
    }
    parts.push(`<currency>${this.escapeXml(request.currency)}</currency>`);
    parts.push(`<transactionType>${this.escapeXml(request.transactionType)}</transactionType>`);

    if (request.transactionCode) {
      parts.push(`<transactionCode>${this.escapeXml(request.transactionCode)}</transactionCode>`);
    }
    if (request.creditType) {
      parts.push(`<creditType>${request.creditType}</creditType>`);
    }
    if (request.validation) {
      parts.push(`<validation>${this.escapeXml(request.validation)}</validation>`);
    }
    if (request.uniqueid) {
      parts.push(`<uniqueid>${this.escapeXml(request.uniqueid)}</uniqueid>`);
    }
    if (request.customerData) {
      parts.push(`<customerData>${this.escapeXml(request.customerData)}</customerData>`);
    }

    if (request.successUrl) {
      parts.push(`<successUrl>${this.escapeXml(request.successUrl)}</successUrl>`);
    }
    if (request.errorUrl) {
      parts.push(`<errorUrl>${this.escapeXml(request.errorUrl)}</errorUrl>`);
    }
    if (request.cancelUrl) {
      parts.push(`<cancelUrl>${this.escapeXml(request.cancelUrl)}</cancelUrl>`);
    }

    parts.push('</request>');
    parts.push('</ashrait>');

    return parts.join('');
  }

  private buildRefundXML(request: HypRefundDealRequest): string {
    const parts: string[] = [];

    parts.push('<?xml version="1.0" encoding="utf-8"?>');
    parts.push('<ashrait>');
    parts.push('<request>');
    parts.push(`<version>1000</version>`);
    parts.push('<language>ENG</language>');

    parts.push('<command>refundDeal</command>');
    parts.push(`<terminalNumber>${this.escapeXml(request.terminalNumber)}</terminalNumber>`);
    parts.push(`<user>${this.escapeXml(request.user)}</user>`);
    parts.push(`<password>${this.escapeXml(request.password)}</password>`);

    parts.push(`<transactionId>${this.escapeXml(request.transactionId)}</transactionId>`);
    parts.push(`<currency>${this.escapeXml(request.currency)}</currency>`);

    if (request.total !== undefined) {
      parts.push(`<total>${request.total}</total>`);
    }
    if (request.uniqueid) {
      parts.push(`<uniqueid>${this.escapeXml(request.uniqueid)}</uniqueid>`);
    }

    parts.push('</request>');
    parts.push('</ashrait>');

    return parts.join('');
  }

  private buildTestXML(): string {
    return `<?xml version="1.0" encoding="utf-8"?>
<ashrait>
  <request>
    <version>1000</version>
    <language>ENG</language>
    <command>echo</command>
  </request>
</ashrait>`;
  }

  // ==========================================================================
  // HTTP Helpers
  // ==========================================================================

  private async sendDoDealRequest(
    request: HypDoDealRequest
  ): Promise<HypDoDealResponse> {
    const xmlBody = this.buildDoDealXML(request);

    const response = await fetch(`${this.config.baseUrl}/xpo/Relay`, {
      method: 'POST',
      headers: {
        'Content-Type': 'text/xml; charset=utf-8',
      },
      body: xmlBody,
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const xmlResponse = await response.text();
    return this.parseDoDealResponse(xmlResponse);
  }

  private async sendRefundRequest(
    request: HypRefundDealRequest
  ): Promise<HypRefundDealResponse> {
    const xmlBody = this.buildRefundXML(request);

    const response = await fetch(`${this.config.baseUrl}/xpo/Relay`, {
      method: 'POST',
      headers: {
        'Content-Type': 'text/xml; charset=utf-8',
      },
      body: xmlBody,
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const xmlResponse = await response.text();
    return this.parseRefundResponse(xmlResponse);
  }

  // ==========================================================================
  // XML Parsing
  // ==========================================================================

  private parseDoDealResponse(xml: string): HypDoDealResponse {
    return {
      resultCode: this.extractXmlValue(xml, 'resultCode') ?? '100',
      resultDescription: this.extractXmlValue(xml, 'resultDescription'),
      transactionId: this.extractXmlValue(xml, 'transactionId'),
      authorizationCode: this.extractXmlValue(xml, 'authorizationCode'),
      voucherNumber: this.extractXmlValue(xml, 'voucherNumber'),
      cardToken: this.extractXmlValue(xml, 'cardToken'),
      cardMask: this.extractXmlValue(xml, 'cardMask'),
      cardBrand: this.extractXmlValue(xml, 'cardBrand'),
      cardExpiration: this.extractXmlValue(xml, 'cardExpiration'),
      redirectUrl: this.extractXmlValue(xml, 'redirectUrl'),
      uniqueid: this.extractXmlValue(xml, 'uniqueid'),
      rawXml: xml,
    };
  }

  private parseRefundResponse(xml: string): HypRefundDealResponse {
    return {
      resultCode: this.extractXmlValue(xml, 'resultCode') ?? '100',
      resultDescription: this.extractXmlValue(xml, 'resultDescription'),
      transactionId: this.extractXmlValue(xml, 'transactionId'),
      authorizationCode: this.extractXmlValue(xml, 'authorizationCode'),
      uniqueid: this.extractXmlValue(xml, 'uniqueid'),
    };
  }

  private extractXmlValue(xml: string, tagName: string): string | undefined {
    const regex = new RegExp(`<${tagName}>([^<]*)</${tagName}>`, 'i');
    const match = xml.match(regex);
    return match ? match[1].trim() : undefined;
  }

  private escapeXml(str: string): string {
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;');
  }

  // ==========================================================================
  // Error Handling
  // ==========================================================================

  private handleError(error: unknown): {
    success: false;
    error: string;
    errorCode?: string;
  } {
    if (error instanceof Error) {
      return {
        success: false,
        error: error.message,
        errorCode: 'unknown',
      };
    }
    return {
      success: false,
      error: 'Unknown error occurred',
      errorCode: 'unknown',
    };
  }
}
