/**
 * Story 080: a server that cannot start says why and what to change, without a
 * secret in sight, and retries on a bounded backoff.
 */
import { describe, expect, test } from 'bun:test'
import { MigrationStepError } from '@crombolo/data'
import {
  bootFailurePage,
  bootRetryDelays,
  DatabaseNotReadyError,
  describeBootFailure,
  UpgradePendingError,
} from '@crombolo/server'

const DB = 'postgres db.internal:5432/site'

describe('describing a boot failure', () => {
  test.each([
    [
      { code: 'ERR_POSTGRES_CONNECTION_REFUSED' },
      "Can't reach the database",
      'CROMBOLO_POSTGRES_URL',
    ],
    [{ errno: '28P01' }, 'The database refused the sign-in', 'user name and password'],
    [{ errno: '3D000' }, 'The database does not exist', 'Create the database'],
    [{ code: 'SQLITE_CANTOPEN' }, "Can't open the database file", 'CROMBOLO_SQLITE_FILE'],
    [
      new Error('Postgres selected but no connection string was provided.'),
      'No database is configured',
      'CROMBOLO_POSTGRES_URL',
    ],
    [new UpgradePendingError(['AddThing']), 'An upgrade is waiting', 'crombolo upgrade'],
    [
      new DatabaseNotReadyError(['AddThing']),
      'The database has not been prepared yet',
      'crombolo upgrade',
    ],
    [
      new MigrationStepError('AddThing', [], undefined, new Error('disk full')),
      'An upgrade step failed',
      'carries on from that step',
    ],
  ])('%p reads as "%s"', (error, title, remedy) => {
    const failure = describeBootFailure(error, DB)
    expect(failure.title).toBe(title)
    expect(failure.remedy).toContain(remedy)
  })

  test('anything else points at the log rather than guessing', () => {
    expect(describeBootFailure(new Error('kaboom'), DB)).toMatchObject({
      title: 'The site could not start',
      remedy: 'Read the latest error in the server log.',
    })
  })

  test('names the database by host, never by a message that could carry a secret', () => {
    const failure = describeBootFailure(
      { errno: '28P01', message: 'password authentication failed for hunter2' },
      DB,
    )
    expect(JSON.stringify(failure)).toContain('db.internal:5432/site')
    expect(JSON.stringify(failure)).not.toContain('hunter2')
  })
})

describe('retrying', () => {
  test('doubles from two seconds up to a minute, one wait fewer than the attempts', () => {
    expect(bootRetryDelays(8)).toEqual([2000, 4000, 8000, 16000, 32000, 60000, 60000])
  })

  test('a single attempt never waits', () => {
    expect(bootRetryDelays(1)).toEqual([])
    expect(bootRetryDelays(0)).toEqual([])
  })
})

describe('the page a starting server serves', () => {
  test('says what is wrong, how to fix it, and when it tries again', () => {
    const html = bootFailurePage(describeBootFailure({ errno: '3D000' }, DB), {
      attempt: 2,
      attempts: 10,
      retryInSeconds: 4,
    })
    expect(html).toContain('The database does not exist')
    expect(html).toContain('<code>CROMBOLO_POSTGRES_URL</code>')
    expect(html).toContain('Trying again in 4 seconds (attempt 2 of 10).')
  })

  test('before anything has failed it only says the site is starting', () => {
    const html = bootFailurePage(undefined, { attempt: 1, attempts: 10, retryInSeconds: undefined })
    expect(html).toContain('The site is starting')
  })
})
