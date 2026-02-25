/**
 * @nehorai/payments - Utilities Exports
 */

// Idempotency
export {
  generateInternalPaymentId,
  generateIdempotencyKey,
  generateDeterministicKey,
  generateOperationKey,
  isValidIdempotencyKey,
  isValidInternalPaymentId,
  extractUuid,
} from './idempotency.js'

// Signature Verification
export {
  verifyWebhookSignature,
  verifyStripeStyleSignature,
  verifySortedFieldsHmacSignature,
  verifyHmacSha256Signature,
  registerSignatureVerifier,
  getSignatureVerifier,
  getSignatureHeaderName,
  type SignatureVerificationParams,
  type SignatureVerificationResult,
  type SignatureVerifier,
} from './signature-verification.js'
