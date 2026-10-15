import { describe, expect, test } from 'bun:test'
import { bumpSteps, parseReleaseVersion, releaseSteps } from '../scripts/release.ts'

describe('parseReleaseVersion', () => {
  test('accepts a three-part version with or without a leading v', () => {
    expect(parseReleaseVersion(['0.7.0'])).toBe('0.7.0')
    expect(parseReleaseVersion(['v0.7.0'])).toBe('0.7.0')
    expect(parseReleaseVersion(['v10.20.30'])).toBe('10.20.30')
  })

  test.each(['0.7', '0.7.0.1', 'V0.7.0', 'vv0.7.0', '0.7.0-beta.1', '0.7.x', ' 0.7.0'])(
    'rejects %p',
    (value) => {
      expect(parseReleaseVersion([value])).toHaveProperty('error')
    },
  )

  test('requires exactly one argument', () => {
    expect(parseReleaseVersion([])).toHaveProperty('error')
    expect(parseReleaseVersion(['0.7.0', '0.8.0'])).toHaveProperty('error')
  })
})

describe('releaseSteps', () => {
  test('bumps, commits, tags, then pushes the commit and tag together', () => {
    expect(bumpSteps('0.7.0')).toEqual([
      ['bun', 'run', 'scripts/version.ts', '0.7.0'],
      ['git', 'add', '--update'],
    ])
    expect(releaseSteps('0.7.0', true)).toEqual([
      ['git', 'commit', '--message', 'bump version->v0.7.0'],
      ['git', 'tag', 'v0.7.0'],
      ['git', 'push', '--atomic', 'origin', 'HEAD', 'refs/tags/v0.7.0'],
    ])
  })

  test('tags the current commit when the packages already carry the version', () => {
    expect(releaseSteps('0.7.0', false)).toEqual([
      ['git', 'tag', 'v0.7.0'],
      ['git', 'push', '--atomic', 'origin', 'HEAD', 'refs/tags/v0.7.0'],
    ])
  })
})
