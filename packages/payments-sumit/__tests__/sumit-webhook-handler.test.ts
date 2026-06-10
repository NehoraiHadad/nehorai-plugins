import { describe, it, expect } from 'vitest';
import { SumitWebhookHandler } from '../src/sumit-webhook-handler.js';

const handler = new SumitWebhookHandler();

describe('SumitWebhookHandler.parseEvent', () => {
  it('normalizes a successful one-time payment', () => {
    const result = handler.parseEvent({
      PaymentID: '1001',
      ValidPayment: true,
      Amount: 49,
      Currency: 'ILS',
    });
    expect(result.success).toBe(true);
    expect(result.event?.eventType).toBe('payment.succeeded');
    expect(result.event?.providerTransactionId).toBe('1001');
    expect(result.event?.amountMinor).toBe(4900);
    expect(result.event?.newStatus).toBe('captured');
  });

  it('normalizes a failed payment and attaches error details', () => {
    const result = handler.parseEvent({
      PaymentID: '1002',
      ValidPayment: false,
      ErrorMessage: 'Card declined',
    });
    expect(result.event?.eventType).toBe('payment.failed');
    expect(result.event?.newStatus).toBe('failed');
    expect(result.event?.error?.message).toBe('Card declined');
  });

  it('normalizes a recurring renewal (IsRecurring + valid)', () => {
    const result = handler.parseEvent({
      PaymentID: '2001',
      IsRecurring: true,
      ValidPayment: true,
    });
    expect(result.event?.eventType).toBe('subscription.renewed');
    expect(result.event?.newStatus).toBe('captured');
  });

  it('normalizes a recurring failure (RecurringID present + invalid)', () => {
    const result = handler.parseEvent({
      PaymentID: '2002',
      RecurringID: '500',
      ValidPayment: false,
    });
    expect(result.event?.eventType).toBe('subscription.payment_failed');
    expect(result.event?.newStatus).toBe('failed');
  });

  it('normalizes a cancellation', () => {
    const result = handler.parseEvent({
      PaymentID: '2003',
      RecurringID: '500',
      Canceled: true,
    });
    expect(result.event?.eventType).toBe('subscription.canceled');
    expect(result.event?.newStatus).toBe('voided');
  });

  it('respects an explicit EventType hint', () => {
    const result = handler.parseEvent({
      PaymentID: '3001',
      EventType: 'card.updated',
    });
    expect(result.event?.eventType).toBe('card.updated');
  });

  it('coerces FORM-style string values (ValidPayment: "true")', () => {
    const result = handler.parseEvent({
      ID: '4001',
      ValidPayment: 'true',
      Amount: '99.5',
    });
    expect(result.event?.eventType).toBe('payment.succeeded');
    expect(result.event?.amountMinor).toBe(9950);
  });

  it('fails when no payment/document id is present', () => {
    const result = handler.parseEvent({ ValidPayment: true });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Missing payment/);
  });

  it('produces a STABLE event id for idempotency (same payload ⇒ same id)', () => {
    const payload = { PaymentID: '5001', ValidPayment: true };
    const a = handler.parseEvent(payload).event?.eventId;
    const b = handler.parseEvent({ ...payload }).event?.eventId;
    expect(a).toBe('5001:payment.succeeded');
    expect(a).toBe(b);
  });

  it('distinguishes events for the same payment by type', () => {
    const ok = handler.parseEvent({ PaymentID: '6001', ValidPayment: true }).event?.eventId;
    const fail = handler.parseEvent({ PaymentID: '6001', ValidPayment: false }).event?.eventId;
    expect(ok).not.toBe(fail);
  });
});

describe('SumitWebhookHandler mapping helpers', () => {
  it('canHandle recognizes the unified events', () => {
    expect(handler.canHandle('payment.succeeded')).toBe(true);
    expect(handler.canHandle('subscription.renewed')).toBe(true);
    expect(handler.canHandle('unknown.event')).toBe(false);
  });

  it('mapStatus maps normalized events to transaction statuses', () => {
    expect(handler.mapStatus('payment.succeeded')).toBe('captured');
    expect(handler.mapStatus('payment.failed')).toBe('failed');
    expect(handler.mapStatus('subscription.canceled')).toBe('voided');
    expect(handler.mapStatus('card.updated')).toBeNull();
  });

  it('processEvent reports status_updated for actionable events and ignores unknown', async () => {
    const updated = await handler.processEvent({
      provider: 'sumit',
      eventId: '1:payment.succeeded',
      eventType: 'payment.succeeded',
      providerTransactionId: '1',
      timestamp: new Date(),
      rawPayload: {},
    });
    expect(updated.action).toBe('status_updated');

    const ignored = await handler.processEvent({
      provider: 'sumit',
      eventId: '1:nope',
      eventType: 'nope',
      providerTransactionId: '1',
      timestamp: new Date(),
      rawPayload: {},
    });
    expect(ignored.action).toBe('ignored_event_type');
  });
});
