/**
 * The browser's view of a condition and the server's must agree.
 *
 * Two implementations exist on purpose: the server is the authority
 * (`@bunbraco/core`), and the script is what makes a field appear between
 * keystrokes without a round trip. If they disagree, a visitor watches a field
 * appear and then gets told it should not have been there — so every operator
 * is run through both and the answers compared.
 */
import { describe, expect, test } from 'bun:test'
import {
  evaluateRule,
  FORM_CONDITION_OPERATORS,
  type FormConditionOperator,
  isShown,
  type SubmittedValues,
} from '@bunbraco/core'
import { FORM_SCRIPT } from '@bunbraco/render'

interface ScriptApi {
  rule(form: unknown, rule: { field: string; operator: string; value?: string }): boolean
  shown(form: unknown, condition: unknown): boolean
}

/**
 * Runs the shipped script with just enough of a browser.
 *
 * A fake form whose `querySelectorAll` answers from a plain object, which is
 * all the rule evaluation touches.
 */
function loadScript(): ScriptApi {
  const globals = {
    window: {} as Record<string, unknown>,
    document: { querySelectorAll: () => [] },
  }
  new Function('window', 'document', FORM_SCRIPT)(globals.window, globals.document)
  return globals.window.__bunbracoForms as ScriptApi
}

/** A stand-in for the rendered form: text inputs holding the given values. */
const fakeForm = (values: SubmittedValues) => ({
  querySelectorAll(selector: string) {
    const alias = /^\[name="(.*)"\]$/.exec(selector)?.[1]?.replace(/\\"/g, '"') ?? ''
    return (values[alias] ?? []).map((value) => ({ type: 'text', value, checked: true }))
  },
})

const script = loadScript()

describe('the script loads', () => {
  test('exposes the two functions, and guards against running twice', () => {
    expect(typeof script.rule).toBe('function')
    expect(typeof script.shown).toBe('function')
    // A second run finds the flag and returns, so two forms do not double-bind.
    const globals = { window: { __bunbracoForms: script } as Record<string, unknown>, document: {} }
    new Function('window', 'document', FORM_SCRIPT)(globals.window, globals.document)
    expect(globals.window.__bunbracoForms).toBe(script)
  })
})

describe('every operator agrees with the server', () => {
  const cases: Array<{ values: SubmittedValues; value?: string; note: string }> = [
    { values: { f: ['Support'] }, value: 'Support', note: 'an exact match' },
    { values: { f: ['Support'] }, value: 'Sales', note: 'no match' },
    { values: { f: ['Support'] }, value: 'upp', note: 'a substring' },
    { values: { f: ['Support'] }, value: 'Sup', note: 'a prefix' },
    { values: { f: ['Support'] }, value: 'ort', note: 'a suffix' },
    { values: {}, value: 'x', note: 'nothing submitted' },
    { values: { f: [''] }, value: 'x', note: 'an empty string' },
    { values: { f: ['a', 'b'] }, value: 'b', note: 'several values' },
    { values: { f: ['10'] }, value: '9', note: 'numbers that sort wrong as text' },
    { values: { f: ['2'] }, value: '10', note: 'numbers the other way' },
    { values: { f: ['b'] }, value: 'a', note: 'text compared as text' },
    { values: { f: ['Support'] }, note: 'no value at all' },
  ]

  for (const operator of FORM_CONDITION_OPERATORS) {
    test(`${operator}`, () => {
      for (const { values, value, note } of cases) {
        const rule = { field: 'f', operator, value }
        const server = evaluateRule(rule, values)
        const browser = script.rule(fakeForm(values), rule)
        expect(browser, `${operator} with ${note}`).toBe(server)
      }
    })
  }
})

describe('show, hide, all and any agree', () => {
  const values: SubmittedValues = { a: ['yes'], b: ['no'] }
  const rules = [
    { field: 'a', operator: 'is' as FormConditionOperator, value: 'yes' },
    { field: 'b', operator: 'is' as FormConditionOperator, value: 'yes' },
  ]

  test('each combination of action and match', () => {
    for (const action of ['show', 'hide'] as const)
      for (const match of ['all', 'any'] as const) {
        const condition = { action, match, rules }
        expect(script.shown(fakeForm(values), condition), `${action}/${match}`).toBe(
          isShown(condition, values),
        )
      }
  })

  test('no condition, and a condition with no rules, are both shown', () => {
    expect(script.shown(fakeForm(values), null)).toBe(isShown(undefined, values))
    expect(script.shown(fakeForm(values), { action: 'show', match: 'all', rules: [] })).toBe(
      isShown({ action: 'show', match: 'all', rules: [] }, values),
    )
  })

  test('an unchecked box counts as nothing, as it does on the server', () => {
    // A checkbox posts nothing when unticked, so the two must agree that the
    // field is empty rather than holding its `value` attribute.
    const form = {
      querySelectorAll: () => [{ type: 'checkbox', value: 'true', checked: false }],
    }
    expect(script.rule(form, { field: 'f', operator: 'isEmpty' })).toBe(
      evaluateRule({ field: 'f', operator: 'isEmpty' }, {}),
    )
  })
})
