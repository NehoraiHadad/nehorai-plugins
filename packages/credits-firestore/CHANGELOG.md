# @nehorai/credits-firestore

## 2.0.0

Compatibility release for `@nehorai/credits` 2.x — the dependency range moves
from `^1.5.0` to `^2.0.0`. No Firestore adapter API changes.

The major version matches core's: core 2.0.0 made `createReservation` /
`updateReservationStatus` loudly record-only (they are not a hold path), and
apps consuming this adapter get that core transitively. Audit callers that
used those two methods as a two-phase commit; holds go through the atomic
reserve family.

This adapter keeps the legacy journaling path: it does not report
`journaled: true`, so `CreditsService` continues to write reset/downgrade
journal entries itself, exactly as on 1.x.
