/**
 * SUMIT Payment Pages — legacy subscription page URL helpers.
 *
 * These helpers support the older per-plan "Payment Page" (דף תשלום) path. The
 * current reference-app flow is Flow B: `beginredirect` charges cycle 1 and saves
 * the card at SUMIT, then the app creates the deferred standing order with
 * `createSubscription({ providerCustomerId, startDate })`.
 *
 * Both functions here are PURE: no network, no credentials, no SDK. They only
 * shape/parse URLs. The per-plan page base URL is INJECTED by the caller
 * (env-configured), so this module stays free of any plan/pricing knowledge.
 *
 * Documented IN params (decorate the page URL):
 *   customerexternalidentifier  ← our userId
 *   externalidentifier          ← our subscriptionId (echoed back on return)
 *   fixedrecurrence             ← cycle count (only when bounded & finite >= 1)
 *   name / emailaddress         ← optional prefill for the buyer
 *   + the success return URL (query key isolated below for WF-0 correction)
 *
 * Documented RETURN params (SUMIT appends to our success redirect):
 *   og-paymentid           → paymentId      (verify via getPayment, grant cycle 1)
 *   og-externalidentifier  → subscriptionId (our subscription record id)
 *   og-customerid          → customerId
 *   og-paymenttype         → paymentType
 *   og-documentnumber      → documentNumber
 */

/**
 * Query key on the payment page that carries OUR success return URL.
 *
 * Isolated as a single named const so it can be corrected after live WF-0
 * (the exact hosted-page param name must be confirmed against a real page).
 */
export const SUCCESS_REDIRECT_QUERY_KEY = 'redirecturl';

/** Params accepted by {@link buildSubscriptionPageUrl}. */
export interface BuildSubscriptionPageUrlParams {
  /** Our user id → customerexternalidentifier. */
  userId: string;
  /** Our subscription record id → externalidentifier (echoed back on return). */
  subscriptionId: string;
  /** Success return URL the buyer lands on after paying. */
  returnUrl: string;
  /**
   * Number of billing cycles → fixedrecurrence. Only emitted when a finite
   * number >= 1; omit/undefined/Infinity ⇒ open-ended (no param sent).
   */
  fixedRecurrence?: number;
  /** Optional buyer name prefill → name. */
  customerName?: string;
  /** Optional buyer email prefill → emailaddress. */
  customerEmail?: string;
}

/** Shape parsed out of the SUMIT success-return query by {@link parseSubscriptionReturn}. */
export interface ParsedSubscriptionReturn {
  paymentId?: string;
  subscriptionId?: string;
  customerId?: string;
  paymentType?: string;
  documentNumber?: string;
}

/** Accepted input shapes for {@link parseSubscriptionReturn}. */
export type SubscriptionReturnQuery =
  | URLSearchParams
  | Record<string, string | string[] | undefined>
  | string;

/**
 * Decorate a pre-built SUMIT payment-page URL with the query params that bind
 * the resulting standing order back to our user + subscription record.
 *
 * Pre-existing query params on `pageBaseUrl` are PRESERVED; our params are
 * added/overwritten. Values are URL-encoded safely (via URLSearchParams).
 */
export function buildSubscriptionPageUrl(
  pageBaseUrl: string,
  params: BuildSubscriptionPageUrlParams
): string {
  const url = new URL(pageBaseUrl);

  // Bind the page to our records.
  url.searchParams.set('customerexternalidentifier', params.userId);
  url.searchParams.set('externalidentifier', params.subscriptionId);
  url.searchParams.set(SUCCESS_REDIRECT_QUERY_KEY, params.returnUrl);

  // Bounded standing order ⇒ fixed number of cycles. Only when finite >= 1.
  if (
    params.fixedRecurrence !== undefined &&
    Number.isFinite(params.fixedRecurrence) &&
    params.fixedRecurrence >= 1
  ) {
    url.searchParams.set('fixedrecurrence', String(params.fixedRecurrence));
  }

  // Optional buyer prefill.
  if (params.customerName) {
    url.searchParams.set('name', params.customerName);
  }
  if (params.customerEmail) {
    url.searchParams.set('emailaddress', params.customerEmail);
  }

  return url.toString();
}

/** Case-insensitive, array-flattening lookup over the normalized query map. */
function readParam(
  map: Map<string, string>,
  key: string
): string | undefined {
  const value = map.get(key.toLowerCase());
  return value === undefined || value === '' ? undefined : value;
}

/** Normalize any accepted input into a lowercase-keyed string map. */
function normalizeQuery(query: SubscriptionReturnQuery): Map<string, string> {
  const map = new Map<string, string>();

  const set = (rawKey: string, rawValue: string | string[] | undefined) => {
    if (rawValue === undefined) return;
    // Flatten array values → first defined entry.
    const value = Array.isArray(rawValue) ? rawValue[0] : rawValue;
    if (value === undefined) return;
    map.set(rawKey.toLowerCase(), value);
  };

  if (typeof query === 'string') {
    const search = new URLSearchParams(
      query.startsWith('?') ? query.slice(1) : query
    );
    for (const [k, v] of search.entries()) set(k, v);
  } else if (query instanceof URLSearchParams) {
    for (const [k, v] of query.entries()) set(k, v);
  } else {
    for (const [k, v] of Object.entries(query)) set(k, v);
  }

  return map;
}

/**
 * Parse the query SUMIT appends to our success return URL into our domain shape.
 * Reads `og-*` params case-insensitively, flattens array values, and returns
 * `undefined` for any absent (or empty) param.
 */
export function parseSubscriptionReturn(
  query: SubscriptionReturnQuery
): ParsedSubscriptionReturn {
  const map = normalizeQuery(query);
  return {
    paymentId: readParam(map, 'og-paymentid'),
    subscriptionId: readParam(map, 'og-externalidentifier'),
    customerId: readParam(map, 'og-customerid'),
    paymentType: readParam(map, 'og-paymenttype'),
    documentNumber: readParam(map, 'og-documentnumber'),
  };
}
