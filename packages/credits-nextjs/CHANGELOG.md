# @nehorai/credits-nextjs

## 2.1.0

- **`withCredits` runs an operation configured with a cost of `0`.** It runs with
  a placeholder reservation (`id: "free-operation"`, `amount: 0`), logs usage, and
  places no hold and writes no journal entry. `afterCommit` does not fire, because
  nothing was committed. `customCost: 0` is still refused. Requires
  `@nehorai/credits` 2.1.0, whose config accepts a `0`.
- **An operation type missing from `operationCosts` is refused by name.** The
  lookup fell back to a cost of `0`, which only failed because reserving `0` is
  refused, with a misleading "greater than zero" message. With `0` now meaning
  free, that fallback would have made every unknown operation free. The call
  returns `{ success: false, error: 'Unknown operation type: ...' }`, matching
  `createGenericAdapter`.

## 2.0.0

Compatibility release for `@nehorai/credits` 2.x — the dependency range moves
from `^1.5.0` to `^2.0.0`. No adapter API changes; the major version matches
core's (see the `@nehorai/credits` 2.0.0 changelog for what changed there,
chiefly `createReservation` becoming loudly record-only).
