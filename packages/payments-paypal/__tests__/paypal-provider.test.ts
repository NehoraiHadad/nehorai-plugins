import { describe, it, expect, vi, afterEach } from 'vitest';
import { PaypalProvider } from '../src/paypal-provider.js';

const config = {
  clientId: 'test-client-id',
  clientSecret: 'test-client-secret',
  environment: 'sandbox' as const,
  webhookId: 'WH-TEST-ID',
};

/** A canned OAuth token response used to satisfy getAccessToken(). */
const TOKEN_BODY = {
  access_token: 'A21AA-test-token',
  token_type: 'Bearer',
  expires_in: 32400,
};

interface MockResponse {
  ok?: boolean;
  status?: number;
  body: unknown;
}

/**
 * Build a fetch mock that returns TOKEN_BODY for the OAuth endpoint and the
 * queued responses (in order) for every other call. Returns the spy.
 */
function mockFetchSequence(responses: MockResponse[]) {
  const queue = [...responses];
  const spy = vi.fn(async (url: string, _init?: RequestInit) => {
    if (String(url).includes('/v1/oauth2/token')) {
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        text: async () => JSON.stringify(TOKEN_BODY),
        json: async () => TOKEN_BODY,
      };
    }
    const next = queue.shift();
    if (!next) throw new Error('Unexpected fetch call — queue empty');
    const ok = next.ok ?? true;
    const status = next.status ?? (ok ? 200 : 400);
    return {
      ok,
      status,
      statusText: ok ? 'OK' : 'Error',
      text: async () => JSON.stringify(next.body),
      json: async () => next.body,
    };
  });
  vi.stubGlobal('fetch', spy as unknown as typeof fetch);
  return spy;
}

/** Extract the parsed JSON body of the Nth non-token fetch call. */
function callBody(spy: ReturnType<typeof vi.fn>, index: number): Record<string, unknown> {
  const calls = spy.mock.calls.filter(
    (c) => !String(c[0]).includes('/v1/oauth2/token')
  );
  const init = calls[index][1] as RequestInit;
  return JSON.parse(init.body as string);
}

function callInit(spy: ReturnType<typeof vi.fn>, index: number): RequestInit {
  const calls = spy.mock.calls.filter(
    (c) => !String(c[0]).includes('/v1/oauth2/token')
  );
  return calls[index][1] as RequestInit;
}

describe('PaypalProvider', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('throws when required config (secrets) is missing', () => {
    // @ts-expect-error intentionally invalid
    expect(() => new PaypalProvider({ clientId: 'x' })).toThrow();
  });

  describe('OAuth token cache', () => {
    it('fetches the token once and reuses it across calls', async () => {
      const spy = mockFetchSequence([
        { body: { id: 'ORDER1', status: 'CREATED', links: [{ rel: 'approve', href: 'https://paypal/appr' }] } },
        { body: { status: 'CREATED' } },
      ]);
      const provider = new PaypalProvider(config);
      await provider.createPaymentIntent({
        amount: { amountMinor: 4900, currency: 'USD' },
        userId: 'u',
        idempotencyKey: 'ord_1',
      });
      await provider.getPaymentIntentStatus('ORDER1');

      const tokenCalls = spy.mock.calls.filter((c) =>
        String(c[0]).includes('/v1/oauth2/token')
      );
      expect(tokenCalls).toHaveLength(1);
      // Token call uses Basic auth + form-encoded grant.
      const tokenInit = tokenCalls[0][1] as RequestInit;
      expect((tokenInit.headers as Record<string, string>).Authorization).toMatch(
        /^Basic /
      );
      expect(tokenInit.body).toBe('grant_type=client_credentials');
    });
  });

  describe('createPaymentIntent (create order → approval url)', () => {
    it('creates a CAPTURE order and returns the approval redirect url + order id', async () => {
      const spy = mockFetchSequence([
        {
          status: 201,
          body: {
            id: '5O190127TN364715T',
            status: 'CREATED',
            links: [
              { rel: 'self', href: 'https://api/self' },
              { rel: 'approve', href: 'https://www.sandbox.paypal.com/checkoutnow?token=5O1901' },
            ],
          },
        },
      ]);
      const provider = new PaypalProvider(config);
      const result = await provider.createPaymentIntent({
        amount: { amountMinor: 4900, currency: 'USD' },
        userId: 'user_1',
        idempotencyKey: 'ord_abc123',
        description: 'Story Creator Credits',
        returnUrl: 'https://app.example.com/return',
        metadata: { cancelUrl: 'https://app.example.com/cancel' },
      });

      expect(result.success).toBe(true);
      expect(result.providerIntentId).toBe('5O190127TN364715T');
      expect(result.redirectUrl).toBe(
        'https://www.sandbox.paypal.com/checkoutnow?token=5O1901'
      );

      const body = callBody(spy, 0);
      expect(body.intent).toBe('CAPTURE');
      const pu = (body.purchase_units as Array<Record<string, unknown>>)[0];
      const amount = pu.amount as Record<string, unknown>;
      // 4900 minor USD → "49.00" decimal string.
      expect(amount.value).toBe('49.00');
      expect(amount.currency_code).toBe('USD');
      // internal ref stamped on the purchase unit for reconciliation.
      expect(pu.reference_id).toBe('ord_abc123');
      expect(pu.custom_id).toBe('ord_abc123');
      const appCtx = body.application_context as Record<string, unknown>;
      expect(appCtx.return_url).toBe('https://app.example.com/return');
      expect(appCtx.cancel_url).toBe('https://app.example.com/cancel');
      // idempotency header set from the idempotency key.
      const init = callInit(spy, 0);
      expect((init.headers as Record<string, string>)['PayPal-Request-Id']).toBe(
        'ord_abc123'
      );
    });

    it('accepts the newer rel:"payer-action" approval link', async () => {
      mockFetchSequence([
        {
          body: {
            id: 'ORDER_PA',
            status: 'PAYER_ACTION_REQUIRED',
            links: [{ rel: 'payer-action', href: 'https://paypal/payer-action' }],
          },
        },
      ]);
      const result = await new PaypalProvider(config).createPaymentIntent({
        amount: { amountMinor: 1000, currency: 'USD' },
        userId: 'u',
        idempotencyKey: 'ord_pa',
      });
      expect(result.success).toBe(true);
      expect(result.redirectUrl).toBe('https://paypal/payer-action');
    });

    it('formats a zero-decimal currency (JPY) with no decimals', async () => {
      const spy = mockFetchSequence([
        { body: { id: 'ORDER_JPY', status: 'CREATED', links: [{ rel: 'approve', href: 'https://paypal/appr' }] } },
      ]);
      await new PaypalProvider(config).createPaymentIntent({
        amount: { amountMinor: 100, currency: 'JPY' },
        userId: 'u',
        idempotencyKey: 'ord_jpy',
      });
      const body = callBody(spy, 0);
      const amount = (body.purchase_units as Array<Record<string, unknown>>)[0]
        .amount as Record<string, unknown>;
      // JPY is zero-decimal: 100 minor → "100" (NOT "1.00").
      expect(amount.value).toBe('100');
      expect(amount.currency_code).toBe('JPY');
    });

    it('surfaces a PayPal error envelope', async () => {
      mockFetchSequence([
        {
          ok: false,
          status: 422,
          body: {
            name: 'UNPROCESSABLE_ENTITY',
            message: 'The requested action could not be performed.',
            details: [{ issue: 'CURRENCY_NOT_SUPPORTED', description: 'Currency not supported.' }],
          },
        },
      ]);
      const result = await new PaypalProvider(config).createPaymentIntent({
        amount: { amountMinor: 1000, currency: 'USD' },
        userId: 'u',
        idempotencyKey: 'ord_err',
      });
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/could not be performed/);
      expect(result.errorCode).toBe('UNPROCESSABLE_ENTITY');
    });
  });

  describe('verifyPayment (verify-on-return: GET → capture)', () => {
    const capturedOrder = (value = '49.00', currency = 'USD', captureId = 'CAP123') => ({
      id: 'ORDER1',
      status: 'COMPLETED',
      purchase_units: [
        {
          payments: {
            captures: [
              { id: captureId, status: 'COMPLETED', amount: { currency_code: currency, value } },
            ],
          },
        },
      ],
    });

    it('captures an APPROVED order and verifies a matching amount', async () => {
      const spy = mockFetchSequence([
        // GET order → APPROVED
        { body: { id: 'ORDER1', status: 'APPROVED', purchase_units: [{}] } },
        // POST capture → COMPLETED order with capture embedded
        { status: 201, body: capturedOrder() },
      ]);
      const result = await new PaypalProvider(config).verifyPayment({
        orderId: 'ORDER1',
        expectedAmountMinor: 4900,
      });

      expect(result.verified).toBe(true);
      expect(result.valid).toBe(true);
      expect(result.amountMatches).toBe(true);
      expect(result.amountMinor).toBe(4900);
      expect(result.currency).toBe('USD');
      expect(result.externalRef).toBe('ORDER1');
      expect(result.documentNumber).toBe('CAP123');
      expect(result.captureStatus).toBe('COMPLETED');

      // The second (non-token) call must be the capture POST.
      const captureInit = callInit(spy, 1);
      expect(captureInit.method).toBe('POST');
      expect((captureInit.headers as Record<string, string>)['PayPal-Request-Id']).toBe(
        'ORDER1'
      );
    });

    it('does NOT re-capture an already COMPLETED order (idempotent re-verify)', async () => {
      const spy = mockFetchSequence([
        { body: capturedOrder() }, // GET → already COMPLETED
      ]);
      const result = await new PaypalProvider(config).verifyPayment({
        orderId: 'ORDER1',
      });
      expect(result.verified).toBe(true);
      expect(result.valid).toBe(true);
      // Only the GET happened — no capture POST.
      const nonTokenCalls = spy.mock.calls.filter(
        (c) => !String(c[0]).includes('/v1/oauth2/token')
      );
      expect(nonTokenCalls).toHaveLength(1);
      expect((nonTokenCalls[0][1] as RequestInit).method).toBe('GET');
    });

    it('rejects a valid capture whose amount does not match', async () => {
      mockFetchSequence([
        { body: { id: 'ORDER1', status: 'APPROVED', purchase_units: [{}] } },
        { status: 201, body: capturedOrder() },
      ]);
      const result = await new PaypalProvider(config).verifyPayment({
        orderId: 'ORDER1',
        expectedAmountMinor: 9900,
      });
      expect(result.verified).toBe(false);
      expect(result.valid).toBe(true);
      expect(result.amountMatches).toBe(false);
      expect(result.amountMinor).toBe(4900);
    });

    it('verifies a JPY capture in minor units (zero-decimal)', async () => {
      mockFetchSequence([
        { body: capturedOrder('100', 'JPY', 'CAPJPY') },
      ]);
      const result = await new PaypalProvider(config).verifyPayment({
        orderId: 'ORDER1',
        expectedAmountMinor: 100,
      });
      expect(result.verified).toBe(true);
      expect(result.amountMinor).toBe(100);
      expect(result.currency).toBe('JPY');
    });

    it('does not verify an order that is not capturable', async () => {
      mockFetchSequence([{ body: { id: 'ORDER1', status: 'CREATED' } }]);
      const result = await new PaypalProvider(config).verifyPayment({
        orderId: 'ORDER1',
      });
      expect(result.verified).toBe(false);
      expect(result.valid).toBe(false);
      expect(result.error).toMatch(/not capturable/);
    });

    it('reports a GET failure without verifying', async () => {
      mockFetchSequence([
        { ok: false, status: 404, body: { name: 'RESOURCE_NOT_FOUND', message: 'Not found' } },
      ]);
      const result = await new PaypalProvider(config).verifyPayment({
        orderId: 'ORDER_MISSING',
      });
      expect(result.verified).toBe(false);
      expect(result.valid).toBe(false);
      expect(result.error).toMatch(/Not found/);
    });
  });

  describe('getPaymentIntentStatus', () => {
    it('maps a COMPLETED order to captured', async () => {
      mockFetchSequence([{ body: { id: 'O', status: 'COMPLETED' } }]);
      const { status } = await new PaypalProvider(config).getPaymentIntentStatus('O');
      expect(status).toBe('captured');
    });

    it('maps an APPROVED order to authorized', async () => {
      mockFetchSequence([{ body: { id: 'O', status: 'APPROVED' } }]);
      const { status } = await new PaypalProvider(config).getPaymentIntentStatus('O');
      expect(status).toBe('authorized');
    });
  });

  describe('refund (real capture refund)', () => {
    it('issues a full refund (empty body) and maps COMPLETED → succeeded', async () => {
      const spy = mockFetchSequence([
        { status: 201, body: { id: 'REFUND1', status: 'COMPLETED', amount: { currency_code: 'USD', value: '49.00' } } },
      ]);
      const result = await new PaypalProvider(config).refund({
        providerTransactionId: 'CAP123',
        idempotencyKey: 'refund_ord_1',
      });
      expect(result.success).toBe(true);
      expect(result.status).toBe('succeeded');
      expect(result.providerRefundId).toBe('REFUND1');
      expect(result.refundedAmount).toEqual({ amountMinor: 4900, currency: 'USD' });
      // Full refund → no JSON body sent.
      const init = callInit(spy, 0);
      expect(init.body).toBeUndefined();
      // Hits the capture refund endpoint with the capture id.
      const url = spy.mock.calls.filter((c) => !String(c[0]).includes('/v1/oauth2/token'))[0][0];
      expect(String(url)).toContain('/v2/payments/captures/CAP123/refund');
    });

    it('issues a partial refund with an amount body', async () => {
      const spy = mockFetchSequence([
        { status: 201, body: { id: 'REFUND2', status: 'PENDING', amount: { currency_code: 'USD', value: '10.00' } } },
      ]);
      const result = await new PaypalProvider(config).refund({
        providerTransactionId: 'CAP123',
        amount: { amountMinor: 1000, currency: 'USD' },
        idempotencyKey: 'refund_ord_2',
      });
      expect(result.status).toBe('pending');
      const body = callBody(spy, 0);
      const amount = body.amount as Record<string, unknown>;
      expect(amount.value).toBe('10.00');
      expect(amount.currency_code).toBe('USD');
    });

    it('surfaces a refund error', async () => {
      mockFetchSequence([
        { ok: false, status: 422, body: { name: 'UNPROCESSABLE_ENTITY', message: 'Capture fully refunded' } },
      ]);
      const result = await new PaypalProvider(config).refund({
        providerTransactionId: 'CAP123',
        idempotencyKey: 'refund_ord_3',
      });
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/fully refunded/);
    });
  });

  describe('capture (direct)', () => {
    it('captures an approved order and returns the captured amount', async () => {
      mockFetchSequence([
        {
          status: 201,
          body: {
            id: 'ORDER1',
            status: 'COMPLETED',
            purchase_units: [
              { payments: { captures: [{ id: 'CAP9', status: 'COMPLETED', amount: { currency_code: 'EUR', value: '20.00' } }] } },
            ],
          },
        },
      ]);
      const result = await new PaypalProvider(config).capture({
        providerIntentId: 'ORDER1',
        authorizationCode: 'ORDER1',
        idempotencyKey: 'cap_1',
      });
      expect(result.success).toBe(true);
      expect(result.providerTransactionId).toBe('CAP9');
      expect(result.capturedAmount).toEqual({ amountMinor: 2000, currency: 'EUR' });
    });
  });

  describe('webhook signature verification', () => {
    it('sync validateWebhookSignature always fails closed', () => {
      const provider = new PaypalProvider(config);
      expect(provider.validateWebhookSignature('{}', 'anything')).toBe(false);
    });

    it('async verifyWebhookSignature accepts a SUCCESS verification', async () => {
      const spy = mockFetchSequence([
        { body: { verification_status: 'SUCCESS' } },
      ]);
      const provider = new PaypalProvider(config);
      const ok = await provider.verifyWebhookSignature({
        authAlgo: 'SHA256withRSA',
        certUrl: 'https://api.sandbox.paypal.com/cert.pem',
        transmissionId: 'tid',
        transmissionSig: 'sig',
        transmissionTime: '2026-07-24T00:00:00Z',
        webhookEvent: { id: 'WH-1', event_type: 'PAYMENT.CAPTURE.COMPLETED' },
      });
      expect(ok).toBe(true);
      const body = callBody(spy, 0);
      // Webhook id comes from config, event posted back verbatim.
      expect(body.webhook_id).toBe('WH-TEST-ID');
      expect(body.transmission_id).toBe('tid');
      expect((body.webhook_event as Record<string, unknown>).id).toBe('WH-1');
      const url = spy.mock.calls.filter((c) => !String(c[0]).includes('/v1/oauth2/token'))[0][0];
      expect(String(url)).toContain('/v1/notifications/verify-webhook-signature');
    });

    it('async verifyWebhookSignature rejects a FAILURE verification', async () => {
      mockFetchSequence([{ body: { verification_status: 'FAILURE' } }]);
      const ok = await new PaypalProvider(config).verifyWebhookSignature({
        authAlgo: 'SHA256withRSA',
        certUrl: 'https://api.sandbox.paypal.com/cert.pem',
        transmissionId: 'tid',
        transmissionSig: 'sig',
        transmissionTime: 't',
        webhookEvent: {},
      });
      expect(ok).toBe(false);
    });

    it('fails closed when no webhook id is configured', async () => {
      const provider = new PaypalProvider({
        clientId: 'a',
        clientSecret: 'b',
        environment: 'sandbox',
      });
      const ok = await provider.verifyWebhookSignature({
        authAlgo: 'x',
        certUrl: 'x',
        transmissionId: 'x',
        transmissionSig: 'x',
        transmissionTime: 'x',
        webhookEvent: {},
      });
      expect(ok).toBe(false);
    });
  });

  describe('unsupported operations', () => {
    it('void is not supported for CAPTURE intent', async () => {
      const result = await new PaypalProvider(config).void({
        providerIntentId: 'p',
        authorizationCode: 'a',
        idempotencyKey: 'k',
      });
      expect(result.success).toBe(false);
    });
  });

  describe('base url selection', () => {
    it('uses the live base url when environment is live', async () => {
      const spy = mockFetchSequence([
        { body: { id: 'O', status: 'CREATED', links: [{ rel: 'approve', href: 'https://paypal/appr' }] } },
      ]);
      const provider = new PaypalProvider({
        clientId: 'a',
        clientSecret: 'b',
        environment: 'live',
      });
      await provider.createPaymentIntent({
        amount: { amountMinor: 1000, currency: 'USD' },
        userId: 'u',
        idempotencyKey: 'k',
      });
      const anyCall = spy.mock.calls[0][0];
      expect(String(anyCall)).toContain('https://api-m.paypal.com');
    });
  });
});
