/**
 * Credit lots: where each credit came from and what it was worth.
 *
 * A lot is one grant of credits into one bucket (`balance` or `bonus`), with its funding
 * (`paid`, `free` or `unknown`) and, for paid credits, the value the caller assigned to it
 * in USD micros. Lots record provenance and never gate spending: the bucket fields on the
 * account stay the only source of truth for what may be spent, and every planner here
 * follows a bucket change a writer already decided.
 *
 * Each write keeps three sums equal to the account:
 *
 * - Σ `spendable` of the balance lots = the spendable balance (`balance - held backing`);
 * - Σ `backing` of the balance lots = the held backing (`expiredHoldBacking`, within the balance);
 * - Σ `spendable` of the bonus lots = `bonusCredits` (a bonus lot never has backing).
 *
 * {@link startLotPlan} repairs a ledger another writer left behind (a positive gap opens an
 * `unknown` lot, a negative one is removed in draw order as an unattributed removal), and
 * {@link finishLotPlan} checks the write itself. Both report what they repaired as drift.
 *
 * Draw order, within a bucket: paid lots first, then free and unknown lots together, each
 * group oldest first by `(grantedAt, id)`. Between buckets the account's own order stands:
 * the hold's backing, then spendable balance, then bonus. Every removal (a draw, an expiry,
 * a cap, an adjustment) takes credits in this same order, so the lots left are always the
 * ones the account would spend last.
 *
 * Money is integer USD micros. A removal of `c` credits from a lot granted `g` takes
 * `floor(valueMicros × c / g)` of its value, computed on whole cents; the removal that
 * empties a lot takes whatever value is left, so a lot's shares always add up to its value.
 */

import { CreditError, CreditErrorCode } from "./errors.js";
import { toCents } from "./amount.js";

// ==================== Types ====================

/** The account bucket a lot's credits sit in. */
export type LotBucket = "balance" | "bonus";

/** Whether the credits were paid for. `unknown` means the value is not known. */
export type LotFunding = "paid" | "free" | "unknown";

/** What granted a lot. */
export type LotSourceType =
  | "signup"
  | "purchase"
  | "subscription_cycle"
  | "subscription_upgrade"
  | "admin"
  | "admin_tier"
  | "monthly_reset"
  | "seed"
  | "legacy"
  | "reconcile";

/** How a lot's value was established. */
export type LotValuationBasis = "snapshot" | "inferred" | "free" | "unknown";

/** A lot that still holds credits, as stored inline on the account. */
export interface OpenLot {
  id: string;
  bucket: LotBucket;
  funding: LotFunding;
  /** Credits the lot was opened with. Fixed. */
  granted: number;
  /** Credits still spendable. */
  spendable: number;
  /** Balance lots only: credits kept only to back open holds (`expiredHoldBacking`). */
  backing: number;
  /** USD micros the granted credits are worth. 0 for free, null when unknown. */
  valueMicros: number | null;
  /** USD micros of provider fee on the grant. 0 for free, null when unknown. */
  feeMicros: number | null;
  /** Value that has left the lot by any route: a draw, an expiry, an adjustment, a reversal. */
  drawnValueMicros: number;
  /** Fee that has left the lot, likewise. */
  drawnFeeMicros: number;
  /** ISO 8601. */
  grantedAt: string;
}

/** The inline ledger on an account: its open lots. */
export interface LotLedgerState {
  v: 1;
  open: OpenLot[];
}

/** What a caller says about credits it grants. */
export interface LotSpec {
  funding: LotFunding;
  /**
   * Paid only, and required for it: what the granted credits are worth, in whole USD
   * micros (net revenue, after VAT). Free credits are worth 0 and unknown ones null.
   */
  valueMicros?: number;
  /** Paid only: the provider's fee in whole USD micros. Absent or null means unknown. */
  feeMicros?: number | null;
  /** Defaults per writer, e.g. `purchase` for a credit with a payment reference. */
  sourceType?: LotSourceType;
  /** The grant's own reference, e.g. a payment id. Defaults per writer. */
  sourceRef?: string;
  /** Defaults to `snapshot` for paid, `free` for free and `unknown` for unknown. */
  valuationBasis?: LotValuationBasis;
}

/** The lot's header document, created once when the lot opens. */
export interface LotHeader {
  id: string;
  bucket: LotBucket;
  funding: LotFunding;
  granted: number;
  valueMicros: number | null;
  feeMicros: number | null;
  grantedAt: string;
  sourceType: LotSourceType;
  sourceRef: string | null;
  valuationBasis: LotValuationBasis;
  /** Set when the grant itself is irregular, e.g. `paid_tier_reset`. */
  anomaly?: string;
  /** Set once, when the lot empties. */
  closedAt?: string;
  /** The value that left the lot, set when it closes: equal to `valueMicros`. */
  drawnValueMicros?: number;
  /** The fee that left the lot, set when it closes. */
  drawnFeeMicros?: number;
}

/** The closing totals written to a lot's header when it empties. */
export interface LotClosing {
  id: string;
  closedAt: string;
  valueMicros: number | null;
  feeMicros: number | null;
  drawnValueMicros: number;
  drawnFeeMicros: number;
}

/** A movement of credits out of a lot that is not a draw (no operation paid with it). */
export type LotEventKind = "expire" | "adjustment" | "refund" | "chargeback" | "reconcile";

/** One lot event, stored once under its key. */
export interface LotEvent {
  /** Deterministic within the operation: `<opRef>:<n>`, or the reversal key. */
  key: string;
  kind: LotEventKind;
  lotId: string;
  bucket: LotBucket;
  funding: LotFunding;
  /** Credits that left the lot (or, for an opened reconcile lot, entered it). */
  credits: number;
  /** The value share of those credits. Null when the lot's value is unknown. */
  valueMicros: number | null;
  feeMicros: number | null;
  /** UTC day of the event, `YYYY-MM-DD`. */
  day: string;
  at: string;
  /**
   * Why. Hold settlement: `release`, `expire`. Balance writes: `cycle_replaced`,
   * `tier_balance`, `tier_cap`, `monthly_reset`, `subscription_downgrade`, `deduct`.
   * Reconciliation: `unknown_lot`, `unattributed_removal`. Reversals: `refund`,
   * `chargeback`.
   */
  reason: string;
  /** The operation: a reservation id, grant key, journal reference or reversal key. */
  ref: string;
  /** Refund and chargeback only. */
  reversal?: LotReversalDetail;
}

/** The money side of a refund or chargeback. */
export interface LotReversalDetail {
  /** Money returned to the customer, USD micros. */
  refundMicros: number;
  /** Refund beyond the undrawn value it cancelled: contra-revenue on the event's day. */
  contraRevenueMicros: number | null;
  /** Undrawn value cancelled beyond the refund: kept as revenue on the event's day. */
  retainedRevenueMicros: number | null;
  /** Chargeback only: the provider's dispute fee, USD micros. */
  chargebackFeeMicros: number;
  /** Credits that had already left the lot before this reversal: spent, expired or adjusted. */
  uncollectedCredits: number;
  /** Credits still in the lot that the reversal left, because they back holds or were not asked for. */
  keptCredits: number;
}

/** One lot's share of a committed operation. */
export interface LotDraw {
  lotId: string;
  bucket: LotBucket;
  funding: LotFunding;
  /** `backing` when the hold's own marked credits paid it, else `spendable`. */
  portion: "backing" | "spendable";
  credits: number;
  valueMicros: number | null;
  feeMicros: number | null;
}

/** What a committed operation was paid with. Stored on the reservation and its journal line. */
export interface LotTotals {
  /** Σ value of the drawn credits whose value is known, USD micros. */
  revenueMicros: number;
  /** Σ known fee shares, USD micros. */
  feeMicros: number;
  paidCredits: number;
  freeCredits: number;
  /** Credits of unknown value. Revenue is incomplete while this is above 0. */
  unknownCredits: number;
  /** Credits whose fee share is unknown. The fee is incomplete while this is above 0. */
  unknownFeeCredits: number;
}

/** The account totals the lots follow. */
export interface LotBuckets {
  /** Spendable balance: `balance` less the held backing. */
  spendable: number;
  /** Held backing (`expiredHoldBacking`, within the balance). */
  backing: number;
  /** `bonusCredits`. */
  bonus: number;
}

/** A difference between the lots and the account that a plan repaired. */
export interface LotGap {
  bucket: LotBucket;
  portion: "spendable" | "backing";
  /** Account minus lots: positive opened an unknown lot, negative removed credits. */
  credits: number;
  /** `before`: left by another writer. `after`: this write's own plan disagreed. */
  phase: "before" | "after";
}

/** What a writer passes in: the clock, a lot id source and the operation's reference. */
export interface LotContext {
  /** ISO 8601, the write's time. */
  now: string;
  newLotId: () => string;
  /** Identifies the operation; event keys are `<opRef>:<n>`. */
  opRef: string;
  /** `grantedAt` for legacy lots opened on an account without a ledger. Defaults to `now`. */
  legacyGrantedAt?: string;
}

/** The planned lot writes of one account write. Immutable; every planner returns a new one. */
export interface LotPlan {
  state: LotLedgerState;
  /** Lot headers to create. */
  opened: LotHeader[];
  /** Lots that emptied, with their closing totals. Filled by {@link finishLotPlan}. */
  closed: LotClosing[];
  events: LotEvent[];
  draws: LotDraw[];
  /** Gaps repaired. Empty unless another writer, or this plan, disagreed with the account. */
  drift: LotGap[];
  /** True when the account had no ledger and legacy lots were opened. */
  initialized: boolean;
  /** Irregular grants, e.g. `paid_tier_reset`. */
  anomalies: string[];
  ctx: LotContext;
}

/** What a hook receives after a write that repaired drift or met an anomaly. */
export interface LotDriftReport {
  userId: string;
  operation: string;
  drift: LotGap[];
  anomalies: string[];
}

/** Repository options for the lot ledger. */
export interface LotLedgerOptions {
  /**
   * `on` records lots on every write. Default `off`: no lot is read or written, and the
   * repository behaves exactly as before lots existed.
   */
  lotLedger?: "off" | "on";
  /**
   * Called after a write commits that repaired drift (another writer moved credits without
   * lots) or met an anomaly. Never called inside a transaction. A throw is swallowed.
   */
  onLotDrift?: (report: LotDriftReport) => void;
}

/** A lot ledger refuses to grow past this many open lots. It fails rather than merge. */
export const MAX_OPEN_LOTS = 100;

// ==================== Validation ====================

const FUNDINGS: readonly LotFunding[] = ["paid", "free", "unknown"];
const SOURCE_TYPES: readonly LotSourceType[] = [
  "signup",
  "purchase",
  "subscription_cycle",
  "subscription_upgrade",
  "admin",
  "admin_tier",
  "monthly_reset",
  "seed",
  "legacy",
  "reconcile",
];
const VALUATION_BASES: readonly LotValuationBasis[] = ["snapshot", "inferred", "free", "unknown"];

function isMicros(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function invalidSpec(message: string, spec: unknown): CreditError {
  return new CreditError(message, CreditErrorCode.INVALID_AMOUNT, { lot: spec });
}

/**
 * Refuse a spec the ledger cannot record: an unknown funding, a paid lot without a whole,
 * non-negative `valueMicros`, a fee that is not one, or a value or fee on a lot that is
 * not paid (free credits are worth 0 and unknown ones have no value).
 */
export function assertValidLotSpec(spec: unknown): asserts spec is LotSpec {
  if (typeof spec !== "object" || spec === null) {
    throw invalidSpec("A lot spec must be an object", spec);
  }
  const { funding, valueMicros, feeMicros, sourceType, sourceRef, valuationBasis } = spec as LotSpec;
  if (!FUNDINGS.includes(funding)) {
    throw invalidSpec(`Lot funding must be paid, free or unknown (got ${String(funding)})`, spec);
  }
  // Stored on the lot's header as given, so each must be one of its values: a header
  // holds plain data only.
  if (sourceType !== undefined && !SOURCE_TYPES.includes(sourceType)) {
    throw invalidSpec(`Unknown lot sourceType ${String(sourceType)}`, spec);
  }
  if (sourceRef !== undefined && typeof sourceRef !== "string") {
    throw invalidSpec("Lot sourceRef must be a string", spec);
  }
  if (valuationBasis !== undefined && !VALUATION_BASES.includes(valuationBasis)) {
    throw invalidSpec(`Unknown lot valuationBasis ${String(valuationBasis)}`, spec);
  }
  if (funding === "paid") {
    if (!isMicros(valueMicros)) {
      throw invalidSpec("A paid lot needs valueMicros, a whole number of USD micros >= 0", spec);
    }
    if (feeMicros !== undefined && feeMicros !== null && !isMicros(feeMicros)) {
      throw invalidSpec("feeMicros must be a whole number of USD micros >= 0, or null", spec);
    }
    return;
  }
  if (valueMicros !== undefined || (feeMicros !== undefined && feeMicros !== null)) {
    throw invalidSpec(`A ${funding} lot carries no valueMicros or feeMicros`, spec);
  }
}

// ==================== Arithmetic ====================

/** Whole cents of a stored lot amount. Lots are written on the grid, so this is exact. */
function cents(value: number): number {
  return toCents(value) ?? Math.round(value * 100);
}

function credits(centsValue: number): number {
  return centsValue / 100;
}

/** `floor(total × part / whole)` without leaving the safe integer range. */
function proRata(total: number, part: number, whole: number): number {
  if (whole <= 0) return 0;
  return Number((BigInt(total) * BigInt(part)) / BigInt(whole));
}

const FUNDING_RANK: Record<LotFunding, number> = { paid: 0, free: 1, unknown: 1 };

/** Draw order within a bucket: paid first, then free and unknown, oldest first. */
export function compareLotDrawOrder(a: OpenLot, b: OpenLot): number {
  const rank = FUNDING_RANK[a.funding] - FUNDING_RANK[b.funding];
  if (rank !== 0) return rank;
  if (a.grantedAt !== b.grantedAt) return a.grantedAt < b.grantedAt ? -1 : 1;
  if (a.id === b.id) return 0;
  return a.id < b.id ? -1 : 1;
}

function sumOf(lots: readonly OpenLot[], bucket: LotBucket, portion: "spendable" | "backing") {
  let total = 0;
  for (const lot of lots) if (lot.bucket === bucket) total += cents(lot[portion]);
  return total;
}

/** The account totals the lots add up to, in credits. */
export function lotSums(state: LotLedgerState): LotBuckets {
  return {
    spendable: credits(sumOf(state.open, "balance", "spendable")),
    backing: credits(sumOf(state.open, "balance", "backing")),
    bonus: credits(sumOf(state.open, "bonus", "spendable")),
  };
}

// ==================== Plan plumbing ====================

/** A working copy the planners mutate; every exported planner copies the plan first. */
interface Work {
  open: OpenLot[];
  opened: LotHeader[];
  closed: LotClosing[];
  events: LotEvent[];
  draws: LotDraw[];
  drift: LotGap[];
  initialized: boolean;
  anomalies: string[];
  ctx: LotContext;
}

function toWork(plan: LotPlan): Work {
  return {
    open: plan.state.open.map((lot) => ({ ...lot })),
    opened: [...plan.opened],
    closed: [...plan.closed],
    events: [...plan.events],
    draws: [...plan.draws],
    drift: [...plan.drift],
    initialized: plan.initialized,
    anomalies: [...plan.anomalies],
    ctx: plan.ctx,
  };
}

function toPlan(work: Work): LotPlan {
  return {
    state: { v: 1, open: work.open },
    opened: work.opened,
    closed: work.closed,
    events: work.events,
    draws: work.draws,
    drift: work.drift,
    initialized: work.initialized,
    anomalies: work.anomalies,
    ctx: work.ctx,
  };
}

function nextEventKey(work: Work): string {
  // Draws are not events, so the count of events is the sequence within the operation.
  return `${work.ctx.opRef}:${work.events.length}`;
}

interface Opening {
  bucket: LotBucket;
  spendable: number; // cents
  backing: number; // cents
  spec: LotSpec;
  sourceType: LotSourceType;
  sourceRef: string | null;
  grantedAt?: string;
  anomaly?: string;
}

function openLot(work: Work, opening: Opening): OpenLot | null {
  const granted = opening.spendable + opening.backing;
  if (granted <= 0) return null;
  const { spec } = opening;
  const valueMicros =
    spec.funding === "paid" ? (spec.valueMicros as number) : spec.funding === "free" ? 0 : null;
  const feeMicros =
    spec.funding === "paid" ? (spec.feeMicros ?? null) : spec.funding === "free" ? 0 : null;
  const lot: OpenLot = {
    id: work.ctx.newLotId(),
    bucket: opening.bucket,
    funding: spec.funding,
    granted: credits(granted),
    spendable: credits(opening.spendable),
    backing: credits(opening.backing),
    valueMicros,
    feeMicros,
    drawnValueMicros: 0,
    drawnFeeMicros: 0,
    grantedAt: opening.grantedAt ?? work.ctx.now,
  };
  work.open.push(lot);
  work.opened.push({
    id: lot.id,
    bucket: lot.bucket,
    funding: lot.funding,
    granted: lot.granted,
    valueMicros,
    feeMicros,
    grantedAt: lot.grantedAt,
    sourceType: spec.sourceType ?? opening.sourceType,
    sourceRef: spec.sourceRef ?? opening.sourceRef,
    valuationBasis:
      spec.valuationBasis ??
      (spec.funding === "paid" ? "snapshot" : spec.funding === "free" ? "free" : "unknown"),
    ...(opening.anomaly ? { anomaly: opening.anomaly } : {}),
  });
  return lot;
}

/** Value and fee leaving a lot with `take` cents, the last removal taking the remainder. */
function shareOf(lot: OpenLot, take: number): { value: number | null; fee: number | null } {
  const empties = cents(lot.spendable) + cents(lot.backing) === take;
  const granted = cents(lot.granted);
  const value =
    lot.valueMicros === null
      ? null
      : empties
        ? lot.valueMicros - lot.drawnValueMicros
        : proRata(lot.valueMicros, take, granted);
  const fee =
    lot.feeMicros === null
      ? null
      : empties
        ? lot.feeMicros - lot.drawnFeeMicros
        : proRata(lot.feeMicros, take, granted);
  if (value !== null) lot.drawnValueMicros += value;
  if (fee !== null) lot.drawnFeeMicros += fee;
  return { value, fee };
}

type Portion = "spendable" | "backing";

/**
 * Take `amount` cents out of one portion of a bucket, in draw order. Calls `record` for
 * each lot touched and returns what could not be taken (0 unless the lots fall short).
 */
function takeFrom(
  work: Work,
  bucket: LotBucket,
  portion: Portion,
  amount: number,
  record: (lot: OpenLot, take: number, value: number | null, fee: number | null) => void
): number {
  let left = amount;
  if (left <= 0) return 0;
  const lots = work.open.filter((lot) => lot.bucket === bucket).sort(compareLotDrawOrder);
  for (const lot of lots) {
    if (left <= 0) break;
    const have = cents(lot[portion]);
    if (have <= 0) continue;
    const take = Math.min(have, left);
    const { value, fee } = shareOf(lot, take);
    lot[portion] = credits(have - take);
    record(lot, take, value, fee);
    left -= take;
  }
  return left;
}

/** Move `amount` cents between the portions of the balance lots, in draw order. */
function moveBetween(work: Work, from: Portion, to: Portion, amount: number): number {
  let left = amount;
  const lots = work.open.filter((lot) => lot.bucket === "balance").sort(compareLotDrawOrder);
  for (const lot of lots) {
    if (left <= 0) break;
    const have = cents(lot[from]);
    if (have <= 0) continue;
    const move = Math.min(have, left);
    lot[from] = credits(have - move);
    lot[to] = credits(cents(lot[to]) + move);
    left -= move;
  }
  return left;
}

function recordEvent(
  work: Work,
  kind: LotEventKind,
  reason: string,
  ref: string
): (lot: OpenLot, take: number, value: number | null, fee: number | null) => void {
  return (lot, take, value, fee) => {
    work.events.push({
      key: nextEventKey(work),
      kind,
      lotId: lot.id,
      bucket: lot.bucket,
      funding: lot.funding,
      credits: credits(take),
      valueMicros: value,
      feeMicros: fee,
      day: work.ctx.now.slice(0, 10),
      at: work.ctx.now,
      reason,
      ref,
    });
  };
}

// ==================== Reconcile ====================

function reconcileWork(work: Work, buckets: LotBuckets, phase: "before" | "after"): void {
  const ref = work.ctx.opRef;
  let gapSpendable = cents(buckets.spendable) - sumOf(work.open, "balance", "spendable");
  let gapBacking = cents(buckets.backing) - sumOf(work.open, "balance", "backing");
  const gapBonus = cents(buckets.bonus) - sumOf(work.open, "bonus", "spendable");

  // A mark or unmark another writer made: the same credits, in the other portion.
  if (gapBacking > 0 && gapSpendable < 0) {
    const move = Math.min(gapBacking, -gapSpendable);
    moveBetween(work, "spendable", "backing", move);
    work.drift.push({ bucket: "balance", portion: "backing", credits: credits(move), phase });
    gapBacking -= move;
    gapSpendable += move;
  } else if (gapBacking < 0 && gapSpendable > 0) {
    const move = Math.min(-gapBacking, gapSpendable);
    moveBetween(work, "backing", "spendable", move);
    work.drift.push({ bucket: "balance", portion: "backing", credits: credits(-move), phase });
    gapBacking += move;
    gapSpendable -= move;
  }

  const unknown: LotSpec = { funding: "unknown" };
  const removed = recordEvent(work, "reconcile", "unattributed_removal", ref);
  const opened = (lot: OpenLot | null, gap: number) => {
    if (!lot) return;
    work.events.push({
      key: nextEventKey(work),
      kind: "reconcile",
      lotId: lot.id,
      bucket: lot.bucket,
      funding: lot.funding,
      credits: credits(gap),
      valueMicros: null,
      feeMicros: null,
      day: work.ctx.now.slice(0, 10),
      at: work.ctx.now,
      reason: "unknown_lot",
      ref,
    });
  };

  const balanceUp = Math.max(0, gapSpendable) + Math.max(0, gapBacking);
  if (balanceUp > 0) {
    opened(
      openLot(work, {
        bucket: "balance",
        spendable: Math.max(0, gapSpendable),
        backing: Math.max(0, gapBacking),
        spec: unknown,
        sourceType: "reconcile",
        sourceRef: ref,
      }),
      balanceUp
    );
  }
  if (gapSpendable < 0) takeFrom(work, "balance", "spendable", -gapSpendable, removed);
  if (gapBacking < 0) takeFrom(work, "balance", "backing", -gapBacking, removed);
  if (gapBonus > 0) {
    opened(
      openLot(work, {
        bucket: "bonus",
        spendable: gapBonus,
        backing: 0,
        spec: unknown,
        sourceType: "reconcile",
        sourceRef: ref,
      }),
      gapBonus
    );
  } else if (gapBonus < 0) {
    takeFrom(work, "bonus", "spendable", -gapBonus, removed);
  }

  if (gapSpendable !== 0) {
    work.drift.push({ bucket: "balance", portion: "spendable", credits: credits(gapSpendable), phase });
  }
  if (gapBacking !== 0) {
    work.drift.push({ bucket: "balance", portion: "backing", credits: credits(gapBacking), phase });
  }
  if (gapBonus !== 0) {
    work.drift.push({ bucket: "bonus", portion: "spendable", credits: credits(gapBonus), phase });
  }
}

/**
 * Bring the lots back to the account's totals. A positive gap opens an `unknown` lot
 * (`sourceType: "reconcile"`); a negative one is removed in draw order as an
 * `unattributed_removal` event. Credits that only moved between the spendable and backing
 * portions move between them in the lots. Each repair is recorded in `drift`.
 */
export function reconcileLots(
  plan: LotPlan,
  buckets: LotBuckets,
  phase: "before" | "after" = "before"
): LotPlan {
  const work = toWork(plan);
  reconcileWork(work, buckets, phase);
  return toPlan(work);
}

// ==================== Start and finish ====================

/**
 * Open the plan for one account write, from the ledger stored on the account and the
 * account's totals before the write.
 *
 * An account with no ledger gets one `unknown` lot per bucket that holds credits
 * (`sourceType: "legacy"`), so its history is reported as unknown, never as worth 0. A
 * stored ledger that disagrees with the totals, because a writer without lots moved
 * credits, is reconciled before the write is planned.
 */
export function startLotPlan(
  stored: LotLedgerState | null | undefined,
  before: LotBuckets,
  ctx: LotContext
): LotPlan {
  const work: Work = {
    open: (stored?.open ?? []).map((lot) => ({ ...lot })),
    opened: [],
    closed: [],
    events: [],
    draws: [],
    drift: [],
    initialized: !stored,
    anomalies: [],
    ctx,
  };
  if (!stored) {
    const unknown: LotSpec = { funding: "unknown" };
    const grantedAt = ctx.legacyGrantedAt ?? ctx.now;
    openLot(work, {
      bucket: "balance",
      spendable: cents(before.spendable),
      backing: cents(before.backing),
      spec: unknown,
      sourceType: "legacy",
      sourceRef: null,
      grantedAt,
    });
    openLot(work, {
      bucket: "bonus",
      spendable: cents(before.bonus),
      backing: 0,
      spec: unknown,
      sourceType: "legacy",
      sourceRef: null,
      grantedAt,
    });
    return toPlan(work);
  }
  reconcileWork(work, before, "before");
  return toPlan(work);
}

/**
 * Close the plan against the account's totals after the write: reconcile anything the
 * plan did not account for (reported with `phase: "after"`), close the lots that emptied,
 * and refuse a ledger past {@link MAX_OPEN_LOTS} open lots.
 */
export function finishLotPlan(plan: LotPlan, after: LotBuckets): LotPlan {
  const work = toWork(plan);
  reconcileWork(work, after, "after");
  const open: OpenLot[] = [];
  for (const lot of work.open) {
    if (cents(lot.spendable) + cents(lot.backing) > 0) {
      open.push(lot);
      continue;
    }
    work.closed.push({
      id: lot.id,
      closedAt: work.ctx.now,
      valueMicros: lot.valueMicros,
      feeMicros: lot.feeMicros,
      drawnValueMicros: lot.drawnValueMicros,
      drawnFeeMicros: lot.drawnFeeMicros,
    });
  }
  if (open.length > MAX_OPEN_LOTS) {
    throw new CreditError(
      `The account would hold ${open.length} open credit lots, more than ${MAX_OPEN_LOTS}. ` +
        "Lots are never merged, so the write was refused.",
      CreditErrorCode.LOT_LIMIT_EXCEEDED,
      { openLots: open.length, max: MAX_OPEN_LOTS }
    );
  }
  work.open = open.sort(compareLotDrawOrder);
  return toPlan(work);
}

/** One account write's lots: start from the stored ledger, apply the writer's plan, finish. */
export interface AccountLotPlanInput {
  stored: LotLedgerState | null | undefined;
  /** The account's totals before the write. */
  before: LotBuckets;
  /** The account's totals after the write. */
  after: LotBuckets;
  ctx: LotContext;
  /** The writer's own planners, chained on the started plan. */
  apply?: (plan: LotPlan) => LotPlan;
}

/** {@link startLotPlan}, the writer's planners, then {@link finishLotPlan}. */
export function planAccountLots(input: AccountLotPlanInput): LotPlan {
  const started = startLotPlan(input.stored, input.before, input.ctx);
  return finishLotPlan(input.apply ? input.apply(started) : started, input.after);
}

// ==================== Writer planners ====================

/** A grant into one bucket. */
export interface LotGrantInput {
  bucket: LotBucket;
  credits: number;
  spec: LotSpec;
  /** Used when the spec names none. */
  sourceType: LotSourceType;
  sourceRef?: string | null;
  anomaly?: string;
}

/** Open a lot for credits a writer adds to a bucket. A grant of 0 opens nothing. */
export function planLotGrant(plan: LotPlan, input: LotGrantInput): LotPlan {
  assertValidLotSpec(input.spec);
  const work = toWork(plan);
  openLot(work, {
    bucket: input.bucket,
    spendable: cents(input.credits),
    backing: 0,
    spec: input.spec,
    sourceType: input.sourceType,
    sourceRef: input.sourceRef ?? null,
    anomaly: input.anomaly,
  });
  if (input.anomaly) work.anomalies.push(input.anomaly);
  return toPlan(work);
}

/** How a commit split its amount, as `planHoldCommit` decided it. */
export interface LotDrawInput {
  /** From the hold's own share of the held backing. */
  backing: number;
  /** From the spendable balance. */
  spendable: number;
  /** From `bonusCredits`. */
  bonus: number;
}

/**
 * The draws of a committed operation: each part of the split is taken from its bucket in
 * draw order. Draws are revenue; they are returned in `draws`, not as events.
 */
export function planLotDraws(plan: LotPlan, input: LotDrawInput): LotPlan {
  const work = toWork(plan);
  const draw = (portion: Portion) => (lot: OpenLot, take: number, value: number | null, fee: number | null) => {
    work.draws.push({
      lotId: lot.id,
      bucket: lot.bucket,
      funding: lot.funding,
      portion,
      credits: credits(take),
      valueMicros: value,
      feeMicros: fee,
    });
  };
  takeFrom(work, "balance", "backing", cents(input.backing), draw("backing"));
  takeFrom(work, "balance", "spendable", cents(input.spendable), draw("spendable"));
  takeFrom(work, "bonus", "spendable", cents(input.bonus), draw("spendable"));
  return toPlan(work);
}

/** Credits leaving one portion of a bucket without paying for anything. */
export interface LotRemovalInput {
  bucket: LotBucket;
  portion: Portion;
  credits: number;
  /** `expire` is breakage revenue; `adjustment` is an administrative removal, not revenue. */
  kind: "expire" | "adjustment";
  reason: string;
  ref: string;
}

/** Remove credits in draw order, one event per lot touched. */
export function planLotRemoval(plan: LotPlan, input: LotRemovalInput): LotPlan {
  const work = toWork(plan);
  takeFrom(
    work,
    input.bucket,
    input.portion,
    cents(input.credits),
    recordEvent(work, input.kind, input.reason, input.ref)
  );
  return toPlan(work);
}

/** The balance a replacing write lands on. */
export interface LotReplaceInput {
  /** The new spendable balance: the grant. */
  spendable: number;
  /** The held backing after the write: old credits kept only for open holds. */
  backing: number;
  /** The lot for the new spendable balance. */
  grant: Omit<LotGrantInput, "bucket" | "credits">;
  /** The expiry events' reason, e.g. `cycle_replaced`. */
  reason: string;
  ref: string;
}

/**
 * A write that replaces the balance (`planBalanceTarget`): a subscription cycle, a tier
 * write with a balance. The old balance lots keep the new held backing (their own backing
 * first, then spendable credits in draw order); everything else in them expires as
 * breakage. The new spendable balance opens one lot.
 */
export function planLotReplace(plan: LotPlan, input: LotReplaceInput): LotPlan {
  assertValidLotSpec(input.grant.spec);
  const work = toWork(plan);
  const expire = recordEvent(work, "expire", input.reason, input.ref);
  const backing = sumOf(work.open, "balance", "backing");
  const wanted = cents(input.backing);
  if (wanted > backing) moveBetween(work, "spendable", "backing", wanted - backing);
  else if (wanted < backing) takeFrom(work, "balance", "backing", backing - wanted, expire);
  takeFrom(work, "balance", "spendable", sumOf(work.open, "balance", "spendable"), expire);
  openLot(work, {
    bucket: "balance",
    spendable: cents(input.spendable),
    backing: 0,
    spec: input.grant.spec,
    sourceType: input.grant.sourceType,
    sourceRef: input.grant.sourceRef ?? null,
    anomaly: input.grant.anomaly,
  });
  if (input.grant.anomaly) work.anomalies.push(input.grant.anomaly);
  return toPlan(work);
}

/** The balance a lowering (or topping-up) write lands on. */
export interface LotCapInput {
  spendable: number;
  backing: number;
  /** The expiry events' reason, e.g. `tier_cap` or `monthly_reset`. */
  reason: string;
  ref: string;
  /** A write that may raise the spendable balance (a monthly reset) opens this lot for the rise. */
  topUp?: Omit<LotGrantInput, "bucket" | "credits">;
}

/**
 * A write that keeps the balance and moves it to new totals (`planBalanceCap`, a monthly
 * reset): credits marked or unmarked as backing move between portions in draw order, a
 * spendable excess expires in draw order, and a shortfall opens the `topUp` lot.
 */
export function planLotCap(plan: LotPlan, input: LotCapInput): LotPlan {
  if (input.topUp) assertValidLotSpec(input.topUp.spec);
  const work = toWork(plan);
  const backing = sumOf(work.open, "balance", "backing");
  const wantedBacking = cents(input.backing);
  if (wantedBacking > backing) moveBetween(work, "spendable", "backing", wantedBacking - backing);
  else if (wantedBacking < backing) moveBetween(work, "backing", "spendable", backing - wantedBacking);

  const spendable = sumOf(work.open, "balance", "spendable");
  const wanted = cents(input.spendable);
  if (wanted < spendable) {
    takeFrom(
      work,
      "balance",
      "spendable",
      spendable - wanted,
      recordEvent(work, "expire", input.reason, input.ref)
    );
  } else if (wanted > spendable && input.topUp) {
    openLot(work, {
      bucket: "balance",
      spendable: wanted - spendable,
      backing: 0,
      spec: input.topUp.spec,
      sourceType: input.topUp.sourceType,
      sourceRef: input.topUp.sourceRef ?? null,
      anomaly: input.topUp.anomaly,
    });
    if (input.topUp.anomaly) work.anomalies.push(input.topUp.anomaly);
  }
  return toPlan(work);
}

/** A refund or chargeback against one lot. */
export interface LotReverseInput {
  lotId: string;
  kind: "refund" | "chargeback";
  /** The reversal's key; the event is stored under it. */
  key: string;
  refundMicros: number;
  chargebackFeeMicros?: number;
  /** At most this many credits are taken back. Default: all the lot's spendable credits. */
  credits?: number;
  /** What the account can give up without uncovering a hold: `balance + bonus - reserved`. */
  available: number;
  /** The lot's header, for a lot that has already closed. */
  closedLot?: LotHeader;
}

/** The result of {@link planLotReverse}. */
export interface LotReverseResult {
  plan: LotPlan;
  /** Credits to take out of each bucket. */
  removed: { balance: number; bonus: number };
  event: LotEvent;
}

/**
 * Take back what a lot still holds, for a refund or a chargeback. Only spendable credits
 * leave, and no more than `available`, so every open hold stays covered. The undrawn value
 * they carry cancels deferred revenue; a refund beyond it is contra-revenue, and an undrawn
 * value beyond the refund is kept. Returns null when the lot is neither open nor given as
 * `closedLot`.
 */
export function planLotReverse(plan: LotPlan, input: LotReverseInput): LotReverseResult | null {
  if (!isMicros(input.refundMicros)) {
    throw invalidSpec("refundMicros must be a whole number of USD micros >= 0", input);
  }
  const chargebackFee = input.chargebackFeeMicros ?? 0;
  if (!isMicros(chargebackFee)) {
    throw invalidSpec("chargebackFeeMicros must be a whole number of USD micros >= 0", input);
  }
  if (input.credits !== undefined && (toCents(input.credits) === null || input.credits < 0)) {
    throw invalidSpec("credits must be an amount >= 0 on the cent grid", input);
  }

  const work = toWork(plan);
  const lot = work.open.find((open) => open.id === input.lotId);
  const header = lot ?? input.closedLot;
  if (!header) return null;

  const held = lot ? cents(lot.spendable) + cents(lot.backing) : 0;
  const take = lot
    ? Math.max(
        0,
        Math.min(
          cents(lot.spendable),
          input.credits === undefined ? Number.MAX_SAFE_INTEGER : cents(input.credits),
          cents(input.available)
        )
      )
    : 0;
  let value: number | null = lot ? 0 : (header.valueMicros === null ? null : 0);
  let fee: number | null = lot ? 0 : (header.feeMicros === null ? null : 0);
  if (lot) {
    if (take > 0) {
      const share = shareOf(lot, take);
      value = share.value;
      fee = share.fee;
      lot.spendable = credits(cents(lot.spendable) - take);
    } else {
      value = lot.valueMicros === null ? null : 0;
      fee = lot.feeMicros === null ? null : 0;
    }
  }

  const event: LotEvent = {
    key: input.key,
    kind: input.kind,
    lotId: input.lotId,
    bucket: header.bucket,
    funding: header.funding,
    credits: credits(take),
    valueMicros: value,
    feeMicros: fee,
    day: work.ctx.now.slice(0, 10),
    at: work.ctx.now,
    reason: input.kind,
    ref: input.key,
    reversal: {
      refundMicros: input.refundMicros,
      contraRevenueMicros: value === null ? null : Math.max(0, input.refundMicros - value),
      retainedRevenueMicros: value === null ? null : Math.max(0, value - input.refundMicros),
      chargebackFeeMicros: input.kind === "chargeback" ? chargebackFee : 0,
      uncollectedCredits: credits(cents(header.granted) - held),
      keptCredits: credits(held - take),
    },
  };
  work.events.push(event);
  return {
    plan: toPlan(work),
    removed: {
      balance: header.bucket === "balance" ? credits(take) : 0,
      bonus: header.bucket === "bonus" ? credits(take) : 0,
    },
    event,
  };
}

// ==================== Reading ====================

/** Sum a commit's draws into the totals stored on the reservation. */
export function lotTotalsOf(draws: readonly LotDraw[]): LotTotals {
  const totals = {
    revenueMicros: 0,
    feeMicros: 0,
    paidCredits: 0,
    freeCredits: 0,
    unknownCredits: 0,
    unknownFeeCredits: 0,
  };
  for (const draw of draws) {
    const drawn = cents(draw.credits);
    if (draw.funding === "paid") totals.paidCredits += drawn;
    else if (draw.funding === "free") totals.freeCredits += drawn;
    if (draw.valueMicros === null) totals.unknownCredits += drawn;
    else totals.revenueMicros += draw.valueMicros;
    if (draw.feeMicros === null) totals.unknownFeeCredits += drawn;
    else totals.feeMicros += draw.feeMicros;
  }
  return {
    ...totals,
    paidCredits: credits(totals.paidCredits),
    freeCredits: credits(totals.freeCredits),
    unknownCredits: credits(totals.unknownCredits),
    unknownFeeCredits: credits(totals.unknownFeeCredits),
  };
}

/** What an account's open lots hold. */
export interface LotLedgerSummary {
  openLots: number;
  paidCredits: number;
  freeCredits: number;
  unknownCredits: number;
  /** Undrawn value of the open lots whose value is known: deferred revenue, USD micros. */
  deferredValueMicros: number;
  /** Credits in open lots whose value is unknown. */
  unknownValueCredits: number;
}

/** Summarise an account's open lots. */
export function summarizeLots(state: LotLedgerState): LotLedgerSummary {
  const totals = { paid: 0, free: 0, unknown: 0, deferred: 0, unknownValue: 0 };
  for (const lot of state.open) {
    const held = cents(lot.spendable) + cents(lot.backing);
    totals[lot.funding] += held;
    if (lot.valueMicros === null) totals.unknownValue += held;
    else totals.deferred += lot.valueMicros - lot.drawnValueMicros;
  }
  return {
    openLots: state.open.length,
    paidCredits: credits(totals.paid),
    freeCredits: credits(totals.free),
    unknownCredits: credits(totals.unknown),
    deferredValueMicros: totals.deferred,
    unknownValueCredits: credits(totals.unknownValue),
  };
}

/**
 * The lot totals of an account's stored fields: the spendable balance, the held backing
 * and the bonus. `held` is the held backing as the account reads it (`heldExpiredBacking`).
 */
export function lotBucketsOf(balance: number, held: number, bonusCredits: number): LotBuckets {
  return {
    spendable: credits(cents(balance) - cents(held)),
    backing: held,
    bonus: bonusCredits,
  };
}
