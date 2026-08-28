import { describe, it, expect } from 'vitest';
import { PaypalWebhookHandler } from '../src/paypal-webhook-handler.js';
import {
  mapSubscriptionStatus,
  mapEventToTransactionStatus,
  PAYPAL_WEBHOOK_EVENT_MAP,
} from '../src/paypal-types.js';

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

describe('PaypalWebhookHandler.parseEvent — subscription events', () => {
  it('normalizes the recurring charge (PAYMENT.SALE.COMPLETED) and exposes the subscription id via billing_agreement_id', () => {
    const rawPayload = {
      id: 'WH-SALE-1',
      event_type: 'PAYMENT.SALE.COMPLETED',
      create_time: '2026-08-24T10:00:00Z',
      resource: {
        // v1 sale shape: id = charge/sale id; amount = { total, currency }.
        id: 'SALE-9AB',
        state: 'completed',
        amount: { total: '49.00', currency: 'USD' },
        // The owning subscription id lives here.
        billing_agreement_id: 'I-BW452GLLEP1G',
      },
    };
    const result = handler.parseEvent(rawPayload);
    expect(result.success).toBe(true);
    expect(result.event?.eventType).toBe('subscription.renewed');
    expect(result.event?.eventId).toBe('WH-SALE-1');
    // providerTransactionId is the SALE id (per-cycle idempotency key).
    expect(result.event?.providerTransactionId).toBe('SALE-9AB');
    // The subscription id is reachable via rawPayload.resource.billing_agreement_id.
    const resource = result.event?.rawPayload.resource as Record<string, unknown>;
    expect(resource.billing_agreement_id).toBe('I-BW452GLLEP1G');
    // Amount parsed from the v1 { total, currency } shape.
    expect(result.event?.amountMinor).toBe(4900);
    expect(result.event?.currency).toBe('USD');
    expect(result.event?.newStatus).toBe('captured');
  });

  it('normalizes BILLING.SUBSCRIPTION.CANCELLED with resource.id as the subscription id', () => {
    const result = handler.parseEvent({
      id: 'WH-SUB-CANCEL',
      event_type: 'BILLING.SUBSCRIPTION.CANCELLED',
      create_time: '2026-08-24T10:00:00Z',
      resource: { id: 'I-BW452GLLEP1G', status: 'CANCELLED' },
    });
    expect(result.success).toBe(true);
    expect(result.event?.eventType).toBe('subscription.canceled');
    expect(result.event?.providerTransactionId).toBe('I-BW452GLLEP1G');
    expect(result.event?.newStatus).toBe('voided');
  });

  it('normalizes BILLING.SUBSCRIPTION.ACTIVATED (no transaction status)', () => {
    const result = handler.parseEvent({
      id: 'WH-SUB-ACT',
      event_type: 'BILLING.SUBSCRIPTION.ACTIVATED',
      resource: { id: 'I-1', status: 'ACTIVE' },
    });
    expect(result.event?.eventType).toBe('subscription.activated');
    expect(result.event?.providerTransactionId).toBe('I-1');
    // Lifecycle-only signal → no money movement, newStatus undefined.
    expect(result.event?.newStatus).toBeUndefined();
  });

  it('normalizes BILLING.SUBSCRIPTION.SUSPENDED and EXPIRED', () => {
    const suspended = handler.parseEvent({
      id: 'WH-SUB-SUS',
      event_type: 'BILLING.SUBSCRIPTION.SUSPENDED',
      resource: { id: 'I-1', status: 'SUSPENDED' },
    });
    expect(suspended.event?.eventType).toBe('subscription.suspended');
    expect(suspended.event?.newStatus).toBeUndefined();

    const expired = handler.parseEvent({
      id: 'WH-SUB-EXP',
      event_type: 'BILLING.SUBSCRIPTION.EXPIRED',
      resource: { id: 'I-1', status: 'EXPIRED' },
    });
    expect(expired.event?.eventType).toBe('subscription.expired');
    expect(expired.event?.newStatus).toBe('voided');
  });

  it('normalizes BILLING.SUBSCRIPTION.PAYMENT.FAILED with error details', () => {
    const result = handler.parseEvent({
      id: 'WH-SUB-FAIL',
      event_type: 'BILLING.SUBSCRIPTION.PAYMENT.FAILED',
      summary: 'Subscription payment failed',
      resource: { id: 'I-1', status: 'ACTIVE' },
    });
    expect(result.event?.eventType).toBe('subscription.payment_failed');
    expect(result.event?.newStatus).toBe('failed');
    expect(result.event?.error?.code).toBe('PAYMENT_FAILED');
    expect(result.event?.error?.message).toMatch(/failed/i);
  });

  it('canHandle recognizes the subscription events', () => {
    expect(handler.canHandle('subscription.renewed')).toBe(true);
    expect(handler.canHandle('subscription.canceled')).toBe(true);
    expect(handler.canHandle('subscription.activated')).toBe(true);
    expect(handler.canHandle('subscription.payment_failed')).toBe(true);
  });
});

describe('mapSubscriptionStatus', () => {
  it('maps PayPal subscription statuses to the unified vocabulary', () => {
    expect(mapSubscriptionStatus('ACTIVE')).toBe('active');
    expect(mapSubscriptionStatus('SUSPENDED')).toBe('paused');
    expect(mapSubscriptionStatus('CANCELLED')).toBe('canceled');
    expect(mapSubscriptionStatus('EXPIRED')).toBe('canceled');
    expect(mapSubscriptionStatus('APPROVAL_PENDING')).toBe('past_due');
    expect(mapSubscriptionStatus('APPROVED')).toBe('past_due');
    expect(mapSubscriptionStatus(undefined)).toBe('past_due');
  });
});

describe('subscription event → transaction status map', () => {
  it('maps the recurring/lifecycle events sensibly', () => {
    expect(mapEventToTransactionStatus('subscription.renewed')).toBe('captured');
    expect(mapEventToTransactionStatus('subscription.payment_failed')).toBe(
      'failed'
    );
    expect(mapEventToTransactionStatus('subscription.canceled')).toBe('voided');
    expect(mapEventToTransactionStatus('subscription.expired')).toBe('voided');
    expect(mapEventToTransactionStatus('subscription.activated')).toBeNull();
    expect(mapEventToTransactionStatus('subscription.suspended')).toBeNull();
  });

  it('maps all subscription raw event types', () => {
    expect(PAYPAL_WEBHOOK_EVENT_MAP['BILLING.SUBSCRIPTION.ACTIVATED']).toBe(
      'subscription.activated'
    );
    expect(PAYPAL_WEBHOOK_EVENT_MAP['PAYMENT.SALE.COMPLETED']).toBe(
      'subscription.renewed'
    );
  });
});

describe('PaypalWebhookHandler mapping helpers', () => {
  it('canHandle recognizes the unified events', () => {
    expect(handler.canHandle('payment.succeeded')).toBe(true);
    expect(handler.canHandle('payment.refunded')).toBe(true);
    // subscription.renewed is now a handled event (see subscription suite).
    expect(handler.canHandle('subscription.renewed')).toBe(true);
    expect(handler.canHandle('totally.unknown')).toBe(false);
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
