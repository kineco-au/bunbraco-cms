/**
 * WP-6.7: the pure rules behind authorization — path access, per-node verb
 * calculation and start-node combination, ported from Umbraco — and the
 * section each operation demands.
 */
import { describe, expect, test } from 'bun:test'
import { LOCAL_LOGIN_OPERATIONS, sectionRequirements } from '@bunbraco/api-management'
import { listOperations, loadSpec } from '@bunbraco/contracts'
import {
  combineStartNodes,
  type GroupGrant,
  generateUserPassword,
  hasPathAccess,
  isValidPassword,
  permissionsForPath,
} from '@bunbraco/core'

const group = (
  alias: string,
  defaults: string[],
  granular: Record<string, string[]> = {},
): GroupGrant => ({ key: alias, alias, defaults, granular: new Map(Object.entries(granular)) })

describe('path access', () => {
  test('root reaches everything, the bin included; a start node reaches itself and below, never the bin', () => {
    expect(hasPathAccess({ root: true, keys: [] }, ['a', 'b'], true)).toBe(true)
    const start = { root: false, keys: ['b'] }
    expect(hasPathAccess(start, ['a', 'b'], false)).toBe(true)
    expect(hasPathAccess(start, ['a', 'b', 'c'], false)).toBe(true)
    expect(hasPathAccess(start, ['a'], false)).toBe(false)
    expect(hasPathAccess(start, ['a', 'b', 'c'], true)).toBe(false)
    expect(hasPathAccess({ root: false, keys: [] }, ['a'], false)).toBe(false)
  })
})

describe('verbs on a node', () => {
  test("the nearest explicit setting replaces a group's defaults; groups union", () => {
    const writers = group('writer', ['Read', 'Update'], { b: ['Read'], d: [] })
    const editors = group('editor', ['Read', 'Delete'])
    expect([...permissionsForPath([writers], ['a'])].sort()).toEqual(['Read', 'Update'])
    // b is set explicitly, and so is everything below it
    expect([...permissionsForPath([writers], ['a', 'b'])]).toEqual(['Read'])
    expect([...permissionsForPath([writers], ['a', 'b', 'c'])]).toEqual(['Read'])
    // An explicit empty set denies everything
    expect([...permissionsForPath([writers], ['a', 'b', 'c', 'd'])]).toEqual([])
    // Another group's defaults still count
    expect([...permissionsForPath([writers, editors], ['a', 'b', 'c', 'd'])].sort()).toEqual([
      'Delete',
      'Read',
    ])
    // The root itself: defaults
    expect([...permissionsForPath([writers], [])].sort()).toEqual(['Read', 'Update'])
  })
})

describe("combining groups' and a user's start nodes", () => {
  test("groups keep the topmost, the user's keep the deepest, and the user's replace groups' above or below", () => {
    expect(combineStartNodes([['a'], ['a', 'b']], [])).toEqual({ root: false, keys: ['a'] })
    expect(combineStartNodes([[], ['a']], [])).toEqual({ root: true, keys: [] })
    expect(combineStartNodes([], [['a'], ['a', 'b']])).toEqual({ root: false, keys: ['b'] })
    // Umbraco's example: a group with root plus a user start node yields just the node
    expect(combineStartNodes([[]], [['x', 'y']])).toEqual({ root: false, keys: ['y'] })
    // Unrelated nodes stay side by side
    expect(combineStartNodes([['a']], [['c']])).toEqual({ root: false, keys: ['a', 'c'] })
    // A user's root replaces the groups' nodes
    expect(combineStartNodes([['a']], [[]])).toEqual({ root: true, keys: [] })
    expect(combineStartNodes([], [])).toEqual({ root: false, keys: [] })
  })
})

describe('passwords', () => {
  test('ten characters by default; a generated one always passes', () => {
    expect(isValidPassword('123456789')).toBe(false)
    expect(isValidPassword('1234567890')).toBe(true)
    const strict = {
      minimumPasswordLength: 16,
      requireNonLetterOrDigit: true,
      requireDigit: true,
      requireLowercase: true,
      requireUppercase: true,
    }
    expect(isValidPassword('longenoughbutweak', strict)).toBe(false)
    for (let i = 0; i < 50; i++)
      expect(isValidPassword(generateUserPassword(strict), strict)).toBe(true)
  })
})

describe('section requirements', () => {
  const operations = listOperations(loadSpec())
  const need = (operationId: string) => {
    const operation = operations.find((o) => o.operationId === operationId)
    if (!operation) throw new Error(operationId)
    return sectionRequirements(operation)
  }

  test("each area asks for Umbraco's sections", () => {
    expect(need('GetDocumentById')).toEqual([['content']])
    expect(need('GetTreeDocumentRoot')).toEqual([
      ['content', 'media', 'users', 'settings', 'packages', 'members', 'library'],
    ])
    expect(need('GetDocumentTypeById')).toEqual([['content', 'library', 'settings']])
    expect(need('PutDocumentTypeById')).toEqual([['content', 'library', 'settings'], ['settings']])
    expect(need('GetDocumentTypeConfiguration')).toEqual([
      ['content', 'library', 'settings'],
      ['settings'],
    ])
    expect(need('GetTreeDocumentTypeRoot')).toEqual([['settings']])
    expect(need('PostDataType')).toEqual([
      ['content', 'library', 'media', 'members', 'settings'],
      ['settings'],
    ])
    expect(need('GetTemplateById')).toEqual([['settings', 'content']])
    expect(need('PutTemplateById')).toEqual([['settings', 'content'], ['settings']])
    expect(need('GetMediaById')).toEqual([['media']])
    expect(need('GetDictionary')).toEqual([['translation']])
    expect(need('GetTreeDictionaryRoot')).toEqual([['translation', 'settings']])
    expect(need('GetUser')).toEqual([['users']])
    expect(need('GetUserGroup')).toEqual([['users']])
    expect(need('GetFilterUser')).toEqual([['users']])
    expect(need('PostDocumentBlueprintFromDocument')).toEqual([['content']])
    expect(need('PostDocumentBlueprint')).toEqual([['settings']])
    expect(need('GetDocumentBlueprintById')).toEqual([['content', 'settings']])
    expect(need('GetUpgradeSettings')).toEqual(['admin'])
    // Open to every signed-in user
    for (const id of [
      'GetUserCurrent',
      'GetUserData',
      'GetItemDocument',
      'GetCulture',
      'GetLanguage',
      'GetServerInformation',
      'PostTemporaryFile',
    ])
      expect([id, need(id)]).toEqual([id, []])
    expect(need('PostLanguage')).toEqual([['settings']])
  })

  test('the password-reset endpoints are the ones Umbraco opens while local login is allowed', () => {
    for (const id of LOCAL_LOGIN_OPERATIONS)
      expect(operations.find((o) => o.operationId === id)?.anonymous).toBe(false)
  })
})
