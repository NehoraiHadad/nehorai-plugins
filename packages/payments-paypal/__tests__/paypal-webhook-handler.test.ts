import { describe, it, expect } from 'vitest';
import { PaypalWebhookHandler } from '../src/paypal-webhook-handler.js';

const handler = new PaypalWebhookHandler();

describe('PaypalWebhookHandler.parseEvent', () => {
  it('normalizes a successful capture (PAYMENT.CAPTURE.COMPLETED)', () => {
    const result = handler.parseEvent({
      id: 'WH-CAP-1',
      event_type: 'PAYMENT.CAPTURE.COMPLETED',
      resource_type: 'capture',
      create_time: '2026-07-24T10:00:00Z',
      resource: {
        id: 'CAP123',
        status: 'COMPLETED',
        amount: { currency_code: 'USD', value: '49.00' },
        custom_id: 'ord_abc123',
      },
    });
    expect(result.success).toBe(true);
    expect(result.event?.eventType).toBe('payment.succeeded');
    expect(result.event?.eventId).toBe('WH-CAP-1');
    expect(result.event?.providerTransactionId).toBe('CAP123');
    expect(result.event?.amountMinor).toBe(4900);
    expect(result.event?.currency).toBe('USD');
    expect(result.event?.newStatus).toBe('captured');
  });

  it('normalizes a JPY capture into zero-decimal minor units', () => {
    const result = handler.parseEvent({
      id: 'WH-CAP-JPY',
      event_type: 'PAYMENT.CAPTURE.COMPLETED',
      resource: { id: 'CAPJPY', status: 'COMPLETED', amount: { currency_code: 'JPY', value: '100' } },
    });
    expect(result.event?.amountMinor).toBe(100);
  });

  it('normalizes a denied capture with error details', () => {
    const result = handler.parseEvent({
      id: 'WH-CAP-2',
      event_type: 'PAYMENT.CAPTURE.DENIED',
      summary: 'A payment capture was denied',
      resource: { id: 'CAP999', status: 'DECLINED', status_details: { reason: 'DECLINED_BY_RISK' } },
    });
    expect(result.event?.eventType).toBe('payment.failed');
    expect(result.event?.newStatus).toBe('failed');
    expect(result.event?.error?.code).toBe('DECLINED_BY_RISK');
    expect(result.event?.error?.message).toMatch(/denied/);
  });

  it('normalizes a refund (PAYMENT.CAPTURE.REFUNDED)', () => {
    const result = handler.parseEvent({
      id: 'WH-REF-1',
      event_type: 'PAYMENT.CAPTURE.REFUNDED',
      resource: { id: 'REF1', status: 'COMPLETED', amount: { currency_code: 'USD', value: '49.00' } },
    });
    expect(result.event?.eventType).toBe('payment.refunded');
    expect(result.event?.newStatus).toBe('fully_refunded');
    expect(result.event?.amountMinor).toBe(4900);
  });

  it('uses PayPal event id as the (idempotent) event id', () => {
    const payload = {
      id: 'WH-STABLE',
      event_type: 'PAYMENT.CAPTURE.COMPLETED',
      resource: { id: 'CAP1', status: 'COMPLETED', amount: { currency_code: 'USD', value: '1.00' } },
    };
    const a = handler.parseEvent(payload).event?.eventId;
    const b = handler.parseEvent({ ...payload }).event?.eventId;
    expect(a).toBe('WH-STABLE');
    expect(a).toBe(b);
  });

  it('fails on an unsupported event_type', () => {
    const result = handler.parseEvent({
      id: 'WH-X',
      event_type: 'CHECKOUT.ORDER.APPROVED',
      resource: { id: 'O1' },
    });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Unsupported/);
  });

  it('fails when event_type is missing', () => {
    const result = handler.parseEvent({ id: 'WH-Y', resource: {} });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Missing event_type/);
  });
});

describe('PaypalWebhookHandler mapping helpers', () => {
  it('canHandle recognizes the unified events', () => {
    expect(handler.canHandle('payment.succeeded')).toBe(true);
    expect(handler.canHandle('payment.refunded')).toBe(true);
    expect(handler.canHandle('subscription.renewed')).toBe(false);
  });

  it('mapEventType maps a raw PayPal event type to the normalized one', () => {
    expect(handler.mapEventType('PAYMENT.CAPTURE.COMPLETED')).toBe('payment.succeeded');
    // Already-normalized values pass through.
    expect(handler.mapEventType('payment.succeeded')).toBe('payment.succeeded');
  });

  it('mapStatus maps normalized events to transaction statuses', () => {
    expect(handler.mapStatus('payment.succeeded')).toBe('captured');
    expect(handler.mapStatus('payment.failed')).toBe('failed');
    expect(handler.mapStatus('payment.refunded')).toBe('fully_refunded');
  });

  it('processEvent reports the action for actionable events and ignores unknown', async () => {
    const updated = await handler.processEvent({
      provider: 'paypal',
      eventId: 'WH-1',
      eventType: 'payment.succeeded',
      providerTransactionId: 'CAP1',
      timestamp: new Date(),
      rawPayload: {},
    });
    expect(updated.action).toBe('status_updated');

    const refunded = await handler.processEvent({
      provider: 'paypal',
      eventId: 'WH-2',
      eventType: 'payment.refunded',
      providerTransactionId: 'REF1',
      timestamp: new Date(),
      rawPayload: {},
    });
    expect(refunded.action).toBe('refund_processed');

    const ignored = await handler.processEvent({
      provider: 'paypal',
      eventId: 'WH-3',
      eventType: 'nope',
      providerTransactionId: 'x',
      timestamp: new Date(),
      rawPayload: {},
    });
    expect(ignored.action).toBe('ignored_event_type');
  });
});
