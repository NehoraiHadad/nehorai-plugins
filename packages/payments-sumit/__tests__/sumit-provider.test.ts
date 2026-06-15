import { describe, it, expect, vi, afterEach } from 'vitest';
import { SumitProvider } from '../src/sumit-provider.js';
import type { SumitResponse } from '../src/sumit-types.js';

/** Build a fetch mock that returns the given SUMIT envelope as JSON. */
function mockFetch(body: SumitResponse, ok = true, status = 200) {
  return vi.fn(async () => ({
    ok,
    status,
    statusText: ok ? 'OK' : 'Error',
    json: async () => body,
  })) as unknown as typeof fetch;
}

function lastRequestBody(spy: ReturnType<typeof vi.fn>): Record<string, unknown> {
  const init = spy.mock.calls[spy.mock.calls.length - 1][1] as RequestInit;
  return JSON.parse(init.body as string);
}

const config = { companyId: 12345, apiKey: 'test-key', webhookToken: 'tok_secret' };

describe('SumitProvider', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('throws when required config is missing', () => {
    // @ts-expect-error intentionally invalid
    expect(() => new SumitProvider({ apiKey: 'x' })).toThrow();
  });

  describe('createPaymentIntent (one-time hosted checkout)', () => {
    it('returns the hosted redirect URL and sends the verified beginredirect fields', async () => {
      const fetchSpy = mockFetch({
        Status: 0,
        Data: { RedirectURL: 'https://app.sumit.co.il/pay/abc' },
      });
      vi.stubGlobal('fetch', fetchSpy);

      const provider = new SumitProvider(config);
      const result = await provider.createPaymentIntent({
        amount: { amountMinor: 4900, currency: 'ILS' },
        userId: 'user_1',
        idempotencyKey: 'ord_abc123',
        description: 'Story Creator Monthly',
        returnUrl: 'https://app.example.com/return',
        metadata: { customerName: 'Dana Cohen', customerEmail: 'a@b.com', customerPhone: '0501234567' },
      });

      expect(result.success).toBe(true);
      expect(result.redirectUrl).toBe('https://app.sumit.co.il/pay/abc');
      // beginredirect returns no payment id → we key on our own order id.
      expect(result.providerIntentId).toBe('ord_abc123');
      expect(result.status).toBe('created');

      const body = lastRequestBody(fetchSpy as unknown as ReturnType<typeof vi.fn>);
      expect(body.Credentials).toEqual({ CompanyID: 12345, APIKey: 'test-key' });
      // buyer identity from metadata → SUMIT customer (named + emailed receipt).
      expect(body.Customer).toMatchObject({
        Name: 'Dana Cohen',
        EmailAddress: 'a@b.com',
        Phone: '0501234567',
      });
      // internal order id goes to the dedicated ExternalIdentifier field...
      expect(body.ExternalIdentifier).toBe('ord_abc123');
      // ...and is appended to the return URL for the redirect leg.
      expect(String(body.RedirectURL)).toContain('internal_order_id=ord_abc123');
      // amount converted from minor units (4900) to major units (49) and placed
      // in the REQUIRED ChargeItem.UnitPrice field (not Item.Price).
      const items = body.Items as Array<Record<string, unknown>>;
      expect(items[0].UnitPrice).toBe(49);
      expect((items[0].Item as Record<string, unknown>).Price).toBeUndefined();
      // VAT-inclusive prices: VATIncluded must be true (SUMIT defaults to false,
      // which would add VAT on top of our final price).
      expect(body.VATIncluded).toBe(true);
      // no invalid Language enum sent
      expect(body.Language).toBeUndefined();
    });

    it('treats metadata.vatIncluded === false as a pre-VAT price', async () => {
      const fetchSpy = mockFetch({ Status: 0, Data: { RedirectURL: 'https://pay/x' } });
      vi.stubGlobal('fetch', fetchSpy);
      await new SumitProvider(config).createPaymentIntent({
        amount: { amountMinor: 5000, currency: 'ILS' },
        userId: 'u',
        idempotencyKey: 'ord_vat',
        metadata: { vatIncluded: false },
      });
      const body = lastRequestBody(fetchSpy as unknown as ReturnType<typeof vi.fn>);
      expect(body.VATIncluded).toBe(false);
    });

    it('accepts a string "Success" status (enum serialized by name)', async () => {
      vi.stubGlobal(
        'fetch',
        mockFetch({ Status: 'Success', Data: { RedirectURL: 'https://pay/x' } })
      );
      const provider = new SumitProvider(config);
      const result = await provider.createPaymentIntent({
        amount: { amountMinor: 1000, currency: 'ILS' },
        userId: 'u',
        idempotencyKey: 'ord_999',
      });
      expect(result.success).toBe(true);
      expect(result.providerIntentId).toBe('ord_999');
    });

    it('surfaces SUMIT errors (non-success Status)', async () => {
      vi.stubGlobal(
        'fetch',
        mockFetch({ Status: 1, UserErrorMessage: 'Invalid API key' })
      );
      const provider = new SumitProvider(config);
      const result = await provider.createPaymentIntent({
        amount: { amountMinor: 1000, currency: 'ILS' },
        userId: 'u',
        idempotencyKey: 'ord_1',
      });
      expect(result.success).toBe(false);
      expect(result.error).toBe('Invalid API key');
    });
  });

  describe('getPaymentIntentStatus (supplementary verification)', () => {
    it('maps a valid payment (Data.Payment.ValidPayment) to captured', async () => {
      vi.stubGlobal(
        'fetch',
        mockFetch({ Status: 0, Data: { Payment: { ID: 77, ValidPayment: true } } })
      );
      const provider = new SumitProvider(config);
      const { status } = await provider.getPaymentIntentStatus('77');
      expect(status).toBe('captured');
    });

    it('maps an invalid payment to failed', async () => {
      vi.stubGlobal(
        'fetch',
        mockFetch({ Status: 0, Data: { Payment: { ID: 77, ValidPayment: false } } })
      );
      const provider = new SumitProvider(config);
      const { status } = await provider.getPaymentIntentStatus('77');
      expect(status).toBe('failed');
    });
  });

  describe('getPayment (authoritative lookup for verify-on-return)', () => {
    it('returns the raw SUMIT payment with amount and order binding', async () => {
      const fetchSpy = mockFetch({
        Status: 0,
        Data: {
          Payment: {
            ID: 77,
            ValidPayment: true,
            Amount: 49,
            Currency: 'ILS',
            ExternalIdentifier: 'ord_abc123',
          },
        },
      });
      vi.stubGlobal('fetch', fetchSpy);

      const provider = new SumitProvider(config);
      const result = await provider.getPayment('77');

      expect(result.success).toBe(true);
      expect(result.payment?.ValidPayment).toBe(true);
      expect(result.payment?.Amount).toBe(49);
      expect(result.payment?.ExternalIdentifier).toBe('ord_abc123');

      const body = lastRequestBody(fetchSpy as unknown as ReturnType<typeof vi.fn>);
      expect(body.PaymentID).toBe(77);
    });

    it('surfaces SUMIT errors without a payment object', async () => {
      vi.stubGlobal(
        'fetch',
        mockFetch({ Status: 1, UserErrorMessage: 'Payment not found' })
      );
      const provider = new SumitProvider(config);
      const result = await provider.getPayment('404404');
      expect(result.success).toBe(false);
      expect(result.payment).toBeUndefined();
      expect(result.error).toBe('Payment not found');
    });
  });

  describe('SumitProvider.verifyPayment', () => {
    const validEnvelope = (overrides: Record<string, unknown> = {}) => ({
      Status: 0,
      Data: {
        Payment: { ValidPayment: true, Amount: 49, Currency: 'ILS', ID: 123, ...overrides },
      },
    });

    it('verifies a valid payment with a matching amount', async () => {
      vi.stubGlobal('fetch', mockFetch(validEnvelope()));
      const provider = new SumitProvider(config);
      const result = await provider.verifyPayment({
        paymentId: '123',
        expectedAmountMinor: 4900,
      });
      expect(result.verified).toBe(true);
      expect(result.valid).toBe(true);
      expect(result.amountMatches).toBe(true);
      expect(result.amountMinor).toBe(4900);
    });

    it('rejects a valid payment whose amount does not match', async () => {
      vi.stubGlobal('fetch', mockFetch(validEnvelope()));
      const provider = new SumitProvider(config);
      const result = await provider.verifyPayment({
        paymentId: '123',
        expectedAmountMinor: 9900,
      });
      expect(result.verified).toBe(false);
      expect(result.valid).toBe(true);
      expect(result.amountMatches).toBe(false);
      expect(result.amountMinor).toBe(4900);
    });

    it('rejects an invalid payment (ValidPayment: false)', async () => {
      vi.stubGlobal('fetch', mockFetch(validEnvelope({ ValidPayment: false })));
      const provider = new SumitProvider(config);
      const result = await provider.verifyPayment({
        paymentId: '123',
        expectedAmountMinor: 4900,
      });
      expect(result.verified).toBe(false);
      expect(result.valid).toBe(false);
    });

    it('verifies a valid payment when no expected amount is given', async () => {
      vi.stubGlobal('fetch', mockFetch(validEnvelope()));
      const provider = new SumitProvider(config);
      const result = await provider.verifyPayment({ paymentId: '123' });
      expect(result.verified).toBe(true);
      expect(result.valid).toBe(true);
      expect(result.amountMatches).toBeUndefined();
      expect(result.amountMinor).toBe(4900);
    });

    it('reports a request failure without verifying', async () => {
      vi.stubGlobal(
        'fetch',
        mockFetch({ Status: 1, UserErrorMessage: 'x' })
      );
      const provider = new SumitProvider(config);
      const result = await provider.verifyPayment({ paymentId: '404404' });
      expect(result.verified).toBe(false);
      expect(result.valid).toBe(false);
      expect(result.error).toBeTruthy();
    });
  });

  describe('createSubscription (recurring standing order)', () => {
    it('requires a payment-method token', async () => {
      const provider = new SumitProvider(config);
      const result = await provider.createSubscription({
        amount: { amountMinor: 2900, currency: 'ILS' },
        userId: 'user_1',
        idempotencyKey: 'sub_ord_1',
        interval: 'monthly',
      });
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/paymentMethodToken/);
    });

    it('charges recurring with the token and returns the RecurringCustomerItemID', async () => {
      const fetchSpy = mockFetch({
        Status: 0,
        Data: { Payment: { ID: 88, ValidPayment: true, RecurringCustomerItemIDs: [55] } },
      });
      vi.stubGlobal('fetch', fetchSpy);

      const provider = new SumitProvider(config);
      const result = await provider.createSubscription({
        amount: { amountMinor: 2900, currency: 'ILS' },
        userId: 'user_1',
        idempotencyKey: 'sub_ord_1',
        interval: 'monthly',
        paymentMethodToken: 'sut_token_123',
      });

      expect(result.success).toBe(true);
      expect(result.providerSubscriptionId).toBe('55');
      expect(result.redirectUrl).toBeUndefined();
      expect(result.status).toBe('active');

      const body = lastRequestBody(fetchSpy as unknown as ReturnType<typeof vi.fn>);
      expect(body.SingleUseToken).toBe('sut_token_123');
      expect(JSON.stringify(body.Items)).toContain('Duration_Months');
    });
  });

  describe('cancelSubscription', () => {
    it('cancels by numeric RecurringCustomerItemID', async () => {
      const fetchSpy = mockFetch({ Status: 0 });
      vi.stubGlobal('fetch', fetchSpy);
      const provider = new SumitProvider(config);
      const result = await provider.cancelSubscription({
        providerSubscriptionId: '55',
        idempotencyKey: 'k',
      });
      expect(result.success).toBe(true);
      expect(result.status).toBe('canceled');
      const body = lastRequestBody(fetchSpy as unknown as ReturnType<typeof vi.fn>);
      expect(body.RecurringCustomerItemID).toBe(55);
    });

    it('rejects a non-numeric subscription id', async () => {
      const provider = new SumitProvider(config);
      const result = await provider.cancelSubscription({
        providerSubscriptionId: 'not-a-number',
        idempotencyKey: 'k',
      });
      expect(result.success).toBe(false);
    });
  });

  describe('validateWebhookSignature (URL token)', () => {
    it('accepts the configured token and rejects others', () => {
      const provider = new SumitProvider(config);
      expect(provider.validateWebhookSignature('{}', 'tok_secret')).toBe(true);
      expect(provider.validateWebhookSignature('{}', 'wrong')).toBe(false);
      expect(provider.validateWebhookSignature('{}', '')).toBe(false);
    });

    it('rejects when no token is configured', () => {
      const provider = new SumitProvider({ companyId: 1, apiKey: 'k' });
      expect(provider.validateWebhookSignature('{}', 'anything')).toBe(false);
    });
  });

  describe('unsupported operations', () => {
    it('void is not supported', async () => {
      const provider = new SumitProvider(config);
      const result = await provider.void({
        providerIntentId: 'p',
        authorizationCode: 'a',
        idempotencyKey: 'k',
      });
      expect(result.success).toBe(false);
    });

    it('refund is not supported', async () => {
      const provider = new SumitProvider(config);
      const result = await provider.refund({
        providerTransactionId: 'p',
        idempotencyKey: 'k',
      });
      expect(result.success).toBe(false);
    });
  });
});
