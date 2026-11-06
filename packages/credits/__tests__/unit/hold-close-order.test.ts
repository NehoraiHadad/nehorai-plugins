/**
 * Final balances do not depend on the order holds close in, on the in-memory adapter.
 * The same table runs on Firestore in `hold-close-order.emulator.test.ts`.
 */
import { describe, expect, it } from "vitest";
import { createInMemoryCreditRepository } from "../../src";
import { validateBalanceUpdate } from "../../src";
import {
  SCENARIOS,
  checkAbsoluteBalanceClearsBacking,
  checkIncrementGuard,
  checkIncrementSparesBacking,
  checkReservedWithoutHolds,
  checkScenario,
} from "../helpers/hold-close-order";

let counter = 0;

describe("holds close in any order (memory)", () => {
  it.each(SCENARIOS.map((s) => [s.name, s] as const))("%s", async (_name, scenario) => {
    const problems = await checkScenario(
      scenario,
      (options) => createInMemoryCreditRepository(options),
      () => `close-order-${++counter}`
    );
    expect(problems).toEqual([]);
  });

  it("refuses an increment through the floor or below 0", async () => {
    await checkIncrementGuard(createInMemoryCreditRepository(), `close-order-${++counter}`);
  });

  it("limits only a charge by the marked credits, not a top-up on a row already under them", () => {
    const row = { balance: 10, bonusCredits: 0, reserved: 0, expiredHoldBacking: 30 };
    expect(validateBalanceUpdate(row, { balanceIncrement: 5 }).valid).toBe(true);
    expect(validateBalanceUpdate(row, { bonusCreditsIncrement: 5 }).valid).toBe(true);
    expect(validateBalanceUpdate(row, { balanceIncrement: -5 }).valid).toBe(false);
  });

  it("charges an increment to valid credits only", async () => {
    await checkIncrementSparesBacking(
      createInMemoryCreditRepository(),
      `close-order-${++counter}`
    );
  });

  it("clears total and shares together on an absolute balance", async () => {
    await checkAbsoluteBalanceClearsBacking(
      createInMemoryCreditRepository(),
      `close-order-${++counter}`
    );
  });

  it("marks only what placed holds can carry", async () => {
    await checkReservedWithoutHolds(createInMemoryCreditRepository(), `close-order-${++counter}`);
  });
});
