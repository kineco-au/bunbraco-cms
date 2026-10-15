/**
 * Story 071: a user or member imported with their Umbraco password hash signs
 * in with the password they had, and the hash is replaced with argon2id.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { SYSTEM_MEMBER_TYPE } from '@crombolo/data'
import { type Harness, signedInServer, signIn, signInAsGroup, V1 } from './support/harness.ts'

// Umbraco's own test vectors: Identity v3 for "Password123!", and Umbraco 8's
// HMAC-SHA256 for "Password123!" with no passwordConfig, as a member upgraded from 8 has.
const IDENTITY_V3 =
  'AQAAAAIAAYagAAAAEJBorDjt+UEvw55UJVsbgAS6T2IGao+2XpCBbO3EKZoAMzoN+CNOpPdu1c0qrFcJVw=='
const UMBRACO_8 = 'yDiU2YyuYZU4jz6F0fpErQ==BxNRHkXBVyJs9gwWF6ktWdfDwYf5bwm+rvV7tOcNNx8='

const open: Harness[] = []
afterEach(async () => {
  while (open.length > 0)
    await open
      .pop()
      ?.db.close()
      .catch(() => {})
})

describe('an imported password', () => {
  test('signs a user in, and is re-hashed to argon2id', async () => {
    const h = await signedInServer()
    open.push(h)
    // A user created as the API does, then given the hash an import carries.
    await signInAsGroup(h, 'writer', 'imported@example.com')
    await h.server.db.exec(
      'UPDATE user_account SET password_hash = ?, password_config = ? WHERE login = ?',
      [IDENTITY_V3, '{"hashAlgorithm":"PBKDF2.ASPNETCORE.V3"}', 'imported@example.com'],
    )
    await expect(
      signIn(h.server, { username: 'imported@example.com', password: 'wrong' }),
    ).rejects.toThrow()
    await signIn(h.server, { username: 'imported@example.com', password: 'Password123!' })
    const [row] = await h.server.db.query<{ password_hash: string; password_config: string }>(
      'SELECT password_hash, password_config FROM user_account WHERE login = ?',
      ['imported@example.com'],
    )
    expect(row?.password_hash.startsWith('$argon2')).toBe(true)
    expect(row?.password_config).toBe('{"hashAlgorithm":"ARGON2ID"}')
    // And the password still works, now against the new hash.
    await signIn(h.server, { username: 'imported@example.com', password: 'Password123!' })
  })

  test('signs a member in on Umbraco 8’s hashing with no config, and is re-hashed', async () => {
    const h = await signedInServer()
    open.push(h)
    const created = await h.post(`${V1}/member`, {
      memberType: { id: SYSTEM_MEMBER_TYPE.key },
      email: 'old@example.test',
      username: 'old',
      password: 'a-placeholder-password',
      isApproved: true,
      groups: [],
      values: [],
      variants: [{ culture: null, segment: null, name: 'old' }],
    })
    expect(created.status).toBe(201)
    const key = created.headers.get('umb-generated-resource') as string
    await h.server.db.exec(
      'UPDATE member SET password = ?, password_config = NULL WHERE node_id = (SELECT id FROM node WHERE unique_id = ?)',
      [UMBRACO_8, key],
    )
    const login = (password: string) =>
      h.server.fetch(
        new Request('http://localhost/umbraco/members/login', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ username: 'old', password }),
        }),
      )
    expect((await login('Password123?')).status).not.toBe(200)
    expect((await login('Password123!')).status).toBe(200)
    const [row] = await h.server.db.query<{ password: string }>(
      'SELECT password FROM member WHERE node_id = (SELECT id FROM node WHERE unique_id = ?)',
      [key],
    )
    expect(row?.password.startsWith('$argon2')).toBe(true)
    expect((await login('Password123!')).status).toBe(200)
  })
})
