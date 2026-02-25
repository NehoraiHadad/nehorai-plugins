/**
 * @nehorai/payments - Webhook Signature Verification
 *
 * Verifies HMAC signatures from payment providers to prevent spoofing.
 * Provides generic verification functions plus a registry pattern
 * for provider-specific verification strategies.
 */

import { createHmac, createHash, timingSafeEqual } from 'crypto'
import type { PaymentProvider } from '../types/index.js'

// ============================================================================
// Types
// ============================================================================

export interface SignatureVerificationParams {
  provider: PaymentProvider
  payload: string
  signature: string
  secret: string
  /** Tolerance in seconds for timestamp validation (default: 300) */
  tolerance?: number
}

export interface SignatureVerificationResult {
  valid: boolean
  error?: string
}

/**
 * A function that verifies a webhook signature for a specific provider
 */
export type SignatureVerifier = (
  payload: string,
  signature: string,
  secret: string,
  tolerance: number
) => SignatureVerificationResult

// ============================================================================
// Built-in Verification Strategies
// ============================================================================

/**
 * Verify a Stripe-style webhook signature
 * Stripe uses: t={timestamp},v1={signature}
 */
export function verifyStripeStyleSignature(
  payload: string,
  signature: string,
  secret: string,
  tolerance: number
): SignatureVerificationResult {
  try {
    const elements = signature.split(',')
    const timestamp = elements.find((e) => e.startsWith('t='))?.slice(2)
    const sig = elements.find((e) => e.startsWith('v1='))?.slice(3)

    if (!timestamp || !sig) {
      return { valid: false, error: 'Invalid signature format' }
    }

    const timestampNum = parseInt(timestamp, 10)
    const now = Math.floor(Date.now() / 1000)
    if (Math.abs(now - timestampNum) > tolerance) {
      return { valid: false, error: 'Timestamp outside tolerance' }
    }

    const signedPayload = `${timestamp}.${payload}`
    const expectedSig = createHmac('sha256', secret)
      .update(signedPayload)
      .digest('hex')

    const valid = timingSafeEqual(
      Buffer.from(sig),
      Buffer.from(expectedSig)
    )

    return { valid }
  } catch (error) {
    return {
      valid: false,
      error: error instanceof Error ? error.message : 'Verification failed',
    }
  }
}

/**
 * Verify an HMAC-SHA256 signature of sorted payload fields
 */
export function verifySortedFieldsHmacSignature(
  payload: string,
  signature: string,
  secret: string,
  _tolerance: number
): SignatureVerificationResult {
  try {
    const data = JSON.parse(payload)
    const sortedKeys = Object.keys(data).sort()
    const sortedPayload = sortedKeys.map((k) => `${k}=${data[k]}`).join('&')

    const expectedSig = createHmac('sha256', secret)
      .update(sortedPayload)
      .digest('hex')

    const valid = timingSafeEqual(
      Buffer.from(signature.toLowerCase()),
      Buffer.from(expectedSig)
    )

    return { valid }
  } catch (error) {
    return {
      valid: false,
      error: error instanceof Error ? error.message : 'Verification failed',
    }
  }
}

/**
 * Verify a simple HMAC-SHA256 signature of the raw payload
 */
export function verifyHmacSha256Signature(
  payload: string,
  signature: string,
  secret: string,
  _tolerance: number
): SignatureVerificationResult {
  try {
    const expectedSig = createHmac('sha256', secret)
      .update(payload)
      .digest('hex')

    const valid = timingSafeEqual(
      Buffer.from(signature.toLowerCase()),
      Buffer.from(expectedSig.toLowerCase())
    )

    return { valid }
  } catch (error) {
    return {
      valid: false,
      error: error instanceof Error ? error.message : 'Verification failed',
    }
  }
}

// ============================================================================
// Verifier Registry
// ============================================================================

const verifierRegistry = new Map<string, SignatureVerifier>()

/**
 * Register a custom signature verifier for a provider
 */
export function registerSignatureVerifier(
  provider: PaymentProvider,
  verifier: SignatureVerifier
): void {
  verifierRegistry.set(provider, verifier)
}

/**
 * Get the registered verifier for a provider
 */
export function getSignatureVerifier(provider: PaymentProvider): SignatureVerifier | undefined {
  return verifierRegistry.get(provider)
}

// ============================================================================
// Main Verification Function
// ============================================================================

/**
 * Verify webhook signature based on provider.
 * Uses registered verifiers. Falls back to HMAC-SHA256 if no verifier is registered.
 */
export function verifyWebhookSignature(
  params: SignatureVerificationParams
): SignatureVerificationResult {
  const { provider, payload, signature, secret, tolerance = 300 } = params

  if (!signature || !secret) {
    return { valid: false, error: 'Missing signature or secret' }
  }

  const verifier = verifierRegistry.get(provider)
  if (verifier) {
    return verifier(payload, signature, secret, tolerance)
  }

  // Default: simple HMAC-SHA256
  return verifyHmacSha256Signature(payload, signature, secret, tolerance)
}

/**
 * Get signature header name for a provider.
 * Returns a generic default; override per provider if needed.
 */
export function getSignatureHeaderName(provider: PaymentProvider): string {
  return `x-${provider}-signature`
}
