/**
 * How `assertInTransaction` reads a failed probe.
 *
 * The distinction it has to get right: "PostgreSQL told me there is no
 * transaction here" is a configuration problem the caller must fix, and it is
 * signalled by exactly one SQLSTATE. Everything else — a deadlock, an aborted
 * transaction, a dropped socket, a driver error with no code at all — belongs
 * to the boundary's classifier, which can tell retryable from deterministic.
 * Collapsing them all into UNSUPPORTED_OPERATION sends the caller after the
 * wrong bug and makes a retryable failure look permanent.
 */

import { describe, expect, it } from 'vitest'
import { CreditErrorCode } from '@nehorai/credits'
import { assertInTransaction, type DrizzleLikeDB } from '../../src/repository/db.js'

/** A handle whose first statement fails with `code`. */
function failingWith(error: unknown): DrizzleLikeDB {
  return {
    select: () => undefined,
    insert: () => undefined,
    update: () => undefined,
    execute: async () => {
      throw error
    },
  }
}

function pgError(code: string, message = `simulated ${code}`): Error & { code: string } {
  return Object.assign(new Error(message), { code })
}

describe('assertInTransaction', () => {
  it('reports a real 25P01 as an unsupported handle', async () => {
    await expect(assertInTransaction(failingWith(pgError('25P01')))).rejects.toMatchObject({
      code: CreditErrorCode.UNSUPPORTED_OPERATION,
      details: { reason: 'no_active_transaction' },
    })
  })

  it('reads 25P01 through a wrapper that carries no code of its own', async () => {
    // Pools and ORMs rethrow with the driver error on `cause`. Looking only at
    // the outermost object would call this "no SQLSTATE" and rethrow it raw.
    const wrapped = new Error('query failed', { cause: pgError('25P01') })
    await expect(assertInTransaction(failingWith(wrapped))).rejects.toMatchObject({
      code: CreditErrorCode.UNSUPPORTED_OPERATION,
      details: { reason: 'no_active_transaction' },
    })
  })

  const PASSED_THROUGH = [
    ['40001', 'serialization failure'],
    ['40P01', 'deadlock detected'],
    ['25P02', 'transaction already aborted'],
    ['08006', 'connection failure'],
    ['57014', 'statement cancelled'],
    ['42P01', 'undefined table'],
  ] as const

  for (const [code, label] of PASSED_THROUGH) {
    it(`rethrows ${code} (${label}) untouched`, async () => {
      const error = pgError(code)
      await expect(assertInTransaction(failingWith(error))).rejects.toBe(error)
    })
  }

  it('rethrows a driver error carrying no SQLSTATE at all', async () => {
    // A missing code is not evidence of anything. Transport failures routinely
    // have none, and calling them "your handle is not transactional" is a lie.
    const error = new Error('socket hang up')
    await expect(assertInTransaction(failingWith(error))).rejects.toBe(error)
  })

  it('refuses a handle whose execute answers nothing', async () => {
    const silent: DrizzleLikeDB = {
      select: () => undefined,
      insert: () => undefined,
      update: () => undefined,
      execute: async () => undefined,
    }
    await expect(assertInTransaction(silent)).rejects.toMatchObject({
      code: CreditErrorCode.UNSUPPORTED_OPERATION,
      details: { reason: 'probe_not_answered' },
    })
  })

  it('accepts a handle that echoes the probe token back', async () => {
    const answering: DrizzleLikeDB = {
      select: () => undefined,
      insert: () => undefined,
      update: () => undefined,
      execute: async () => ({ rows: [{ credits_v2_tx_probe: 'credits_v2_tx_probe_ok' }] }),
    }
    await expect(assertInTransaction(answering)).resolves.toBeUndefined()
  })
})
