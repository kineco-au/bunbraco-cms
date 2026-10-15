/**
 * Story 071: the password hashes an Umbraco site stores, verified against
 * vectors Umbraco wrote — its own unit tests, and the demo store's admin.
 */
import { describe, expect, test } from 'bun:test'
import { pbkdf2Sync, randomBytes } from 'node:crypto'
import {
  isUmbracoPasswordConfig,
  umbracoAlgorithmOf,
  verifyAspNetIdentity,
  verifyUmbraco4,
  verifyUmbraco8,
  verifyUmbracoPassword,
} from '@crombolo/auth'

const V3 = '{"hashAlgorithm":"PBKDF2.ASPNETCORE.V3"}'

describe('ASP.NET Core Identity', () => {
  test('v3 with SHA-512 at 100,000 iterations, as Umbraco 17 writes it', () => {
    // Umbraco's MemberPasswordHasherTests.
    const hash =
      'AQAAAAIAAYagAAAAEJBorDjt+UEvw55UJVsbgAS6T2IGao+2XpCBbO3EKZoAMzoN+CNOpPdu1c0qrFcJVw=='
    expect(verifyAspNetIdentity('Password123!', hash)).toBe(true)
    expect(verifyAspNetIdentity('Password123?', hash)).toBe(false)
  })

  test('v3 with SHA-256 at 10,000 iterations, the older default', () => {
    const hash =
      'AQAAAAEAACcQAAAAEGF/tTVoL6ef3bQPZFYfbgKFu1CDQIAMgyY1N4EDt9jqdG/hsOX93X1U6LNvlIQ3mw=='
    expect(verifyAspNetIdentity('Password123!', hash)).toBe(true)
    expect(verifyAspNetIdentity('wrongPassword', hash)).toBe(false)
  })

  test('v2: a zero byte, a 16-byte salt and PBKDF2-HMAC-SHA1 at 1,000 iterations', () => {
    const salt = randomBytes(16)
    const hash = Buffer.concat([
      Buffer.from([0]),
      salt,
      pbkdf2Sync('correct horse', salt, 1000, 32, 'sha1'),
    ]).toString('base64')
    expect(verifyAspNetIdentity('correct horse', hash)).toBe(true)
    expect(verifyAspNetIdentity('correct horses', hash)).toBe(false)
  })

  test('what is not one of its hashes is simply not a match', () => {
    expect(verifyAspNetIdentity('x', 'not base64!')).toBe(false)
    expect(verifyAspNetIdentity('x', 'AQ==')).toBe(false)
  })
})

describe('Umbraco’s own hashes', () => {
  test('Umbraco 8: a base64 salt then an HMAC-SHA256, or SHA1, of the password', () => {
    // Umbraco's UmbracoPasswordHasherTests.
    expect(
      verifyUmbraco8(
        'Umbraco9Rocks!',
        'uB/pLEhhe1W7EtWMv/pSgg==1y8+aso9+h3AKRtJXlVYeg2TZKJUr64hccj82ZZ7Ksk=',
      ),
    ).toBe(true)
    expect(
      verifyUmbraco8(
        'Umbraco9Rocks!',
        '6tZGfG9NTxJJYp19Fac9og==zzRggqANxhb+CbD/VabEt8cIde8=',
        'SHA1',
      ),
    ).toBe(true)
    expect(
      verifyUmbraco8(
        'Umbraco9Rocks!',
        'aB/cDeFaBcDefAbcD/EfaB==1y8+aso9+h3AKRtJXlVYeg2TZKJUr64hccj82ZZ7Ksk=',
      ),
    ).toBe(false)
  })

  test('Umbraco 4: HMAC-SHA1 keyed with the password, whatever the config says', () => {
    expect(verifyUmbraco4('Umbraco9Rocks!', 't0U8atXTX/efNCtTafukwZeIpr8=')).toBe(true)
    for (const config of [
      '{"hashAlgorithm":"HMACSHA256"}',
      '{"hashAlgorithm":"FOOBARBAZQUX"}',
      null,
    ])
      expect(verifyUmbracoPassword('Umbraco9Rocks!', 't0U8atXTX/efNCtTafukwZeIpr8=', config)).toBe(
        true,
      )
  })
})

describe('choosing the verifier', () => {
  test('Identity first, then Umbraco 4, then what the config names', () => {
    // The Umbraco Commerce demo store's documented administrator, as its
    // database holds them (tests/fixtures/umbraco).
    const demoAdmin =
      'AQAAAAIAAYagAAAAEOsqWpWQ6GWDL5IZjctPBTprvBDjuvUbLrohxr/UvkG1CyOAkE/4j4ad0cYOKfKd2Q=='
    expect(verifyUmbracoPassword('password1234', demoAdmin, V3)).toBe(true)
    expect(verifyUmbracoPassword('password12345', demoAdmin, V3)).toBe(false)
    expect(
      verifyUmbracoPassword(
        'Umbraco9Rocks!',
        'uB/pLEhhe1W7EtWMv/pSgg==1y8+aso9+h3AKRtJXlVYeg2TZKJUr64hccj82ZZ7Ksk=',
        '{"hashAlgorithm":"HMACSHA256"}',
      ),
    ).toBe(true)
  })

  test('a member with no config is assumed to be on Umbraco 8’s hashing; a user is not', () => {
    // Umbraco's MemberPasswordHasherTests: "GivenALegacyPasswordHash".
    const legacy = 'yDiU2YyuYZU4jz6F0fpErQ==BxNRHkXBVyJs9gwWF6ktWdfDwYf5bwm+rvV7tOcNNx8='
    expect(verifyUmbracoPassword('Password123!', legacy, null, true)).toBe(true)
    expect(verifyUmbracoPassword('Password123!', legacy, null, false)).toBe(false)
  })

  test('the config is read for its algorithm, and argon2id is not Umbraco’s', () => {
    expect(umbracoAlgorithmOf(V3)).toBe('PBKDF2.ASPNETCORE.V3')
    expect(umbracoAlgorithmOf('not json')).toBeUndefined()
    expect(isUmbracoPasswordConfig(V3)).toBe(true)
    expect(isUmbracoPasswordConfig('{"hashAlgorithm":"ARGON2ID"}')).toBe(false)
  })
})
