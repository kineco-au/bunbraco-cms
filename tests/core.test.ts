import { describe, expect, test } from 'bun:test'
import {
  DEFAULT_TAKE,
  DEFAULT_UPLOAD_SETTINGS,
  invalidSkipTake,
  isUploadAllowed,
  notFound,
  notImplemented,
  PROBLEM_TYPE,
  paged,
  parseSkipTake,
  problemDetails,
  problemResponse,
  toEditorValue,
  toPublishedValue,
} from '@bunbraco/core'

describe('problem details', () => {
  test('uses the literal string "Error" as type, not a URI', () => {
    // Umbraco emits type: "Error"; the client validates the shape, not the URI.
    expect(PROBLEM_TYPE).toBe('Error')
    expect(problemDetails({ title: 'x', status: 400 }).type).toBe('Error')
  })

  test('carries Umbraco extension members', () => {
    const problem = problemDetails({
      title: 'Validation failed',
      status: 400,
      operationStatus: 'PropertyValidationError',
      errors: { '$.values[0].value': ['Required'] },
      invalidProperties: ['bodyText'],
    })
    expect(problem.operationStatus).toBe('PropertyValidationError')
    expect(problem.errors?.['$.values[0].value']).toEqual(['Required'])
    expect(problem.invalidProperties).toEqual(['bodyText'])
  })

  test('serialises as application/problem+json with the declared status', async () => {
    const response = problemResponse(notFound('Gone', 'no such node'))
    expect(response.status).toBe(404)
    expect(response.headers.get('content-type')).toContain('application/problem+json')
    expect(await response.json()).toEqual({
      type: 'Error',
      title: 'Gone',
      status: 404,
      detail: 'no such node',
      operationStatus: 'NotFound',
    })
  })

  test('names the operation in a 501', () => {
    expect(notImplemented('GetDocumentById').detail).toContain('GetDocumentById')
  })
})

describe('paging', () => {
  const parse = (qs: string) => parseSkipTake(new URLSearchParams(qs))

  test('defaults to skip 0, take 100', () => {
    expect(parse('')).toEqual({ ok: true, value: { skip: 0, take: DEFAULT_TAKE } })
    expect(DEFAULT_TAKE).toBe(100)
  })

  test('accepts a skip that is a multiple of take', () => {
    expect(parse('skip=10&take=5')).toEqual({ ok: true, value: { skip: 10, take: 5 } })
    expect(parse('skip=0&take=7')).toEqual({ ok: true, value: { skip: 0, take: 7 } })
  })

  test('rejects a skip that is not a multiple of take', () => {
    // Umbraco 400s on this and the backoffice relies on the contract.
    expect(parse('skip=3&take=5').ok).toBe(false)
    expect(parse('skip=7&take=2').ok).toBe(false)
  })

  test('rejects negative and non-integer values', () => {
    expect(parse('skip=-5&take=5').ok).toBe(false)
    expect(parse('skip=0&take=-1').ok).toBe(false)
    expect(parse('skip=abc&take=5').ok).toBe(false)
    expect(parse('skip=1.5&take=1').ok).toBe(false)
  })

  test('tolerates take=0 without dividing by zero', () => {
    expect(parse('skip=0&take=0')).toEqual({ ok: true, value: { skip: 0, take: 0 } })
  })

  test('explains itself in the problem detail', () => {
    expect(invalidSkipTake().detail).toContain('multiple of take')
    expect(invalidSkipTake().status).toBe(400)
  })

  test('wraps items in the total/items envelope', () => {
    expect(paged(['a', 'b'], 57)).toEqual({ total: 57, items: ['a', 'b'] })
  })
})

describe('upload settings', () => {
  test("the endpoint's defaults are Umbraco's", () => {
    expect(DEFAULT_UPLOAD_SETTINGS.imageFileTypes).toEqual([
      'jpeg',
      'jpg',
      'gif',
      'bmp',
      'png',
      'tiff',
      'tif',
      'webp',
    ])
    expect(DEFAULT_UPLOAD_SETTINGS.disallowedExtensions).toContain('aspx')
    expect(DEFAULT_UPLOAD_SETTINGS.allowedExtensions).toEqual([])
    expect(DEFAULT_UPLOAD_SETTINGS.maxFileSize).toBeNull()
  })

  test('disallowed always wins; an allow-list, once set, is the only way in', () => {
    expect(isUploadAllowed('photo.JPG', DEFAULT_UPLOAD_SETTINGS)).toBe(true)
    expect(isUploadAllowed('shell.aspx', DEFAULT_UPLOAD_SETTINGS)).toBe(false)
    expect(isUploadAllowed('web.Config', DEFAULT_UPLOAD_SETTINGS)).toBe(false)
    const onlyPdf = { ...DEFAULT_UPLOAD_SETTINGS, allowedExtensions: ['pdf', 'aspx'] }
    expect(isUploadAllowed('report.pdf', onlyPdf)).toBe(true)
    expect(isUploadAllowed('photo.png', onlyPdf)).toBe(false)
    expect(isUploadAllowed('shell.aspx', onlyPdf)).toBe(false)
  })
})

describe('property values', () => {
  const RTE = 'Umbraco.RichText'
  const rte = {
    markup: '<p>x</p>',
    blocks: { layout: {}, contentData: [], settingsData: [], expose: [] },
  }

  test('rich text reaches the editor as { markup, blocks }, whatever was stored', () => {
    expect(toEditorValue(RTE, JSON.stringify(rte))).toEqual(rte)
    expect(toEditorValue(RTE, '<p>legacy html</p>')).toEqual({
      markup: '<p>legacy html</p>',
      blocks: null,
    })
    // What an earlier build stored after the editor spread a JSON string
    expect(
      toEditorValue(RTE, JSON.stringify({ ...(JSON.stringify(rte) as unknown as object) })),
    ).toEqual(rte)
    expect(toEditorValue(RTE, null)).toBeNull()
  })

  test('templates get rich text as its markup', () => {
    expect(toPublishedValue(RTE, JSON.stringify(rte))).toBe('<p>x</p>')
  })

  test('structured editors get parsed JSON; plain editors get the text as stored', () => {
    expect(toEditorValue('Umbraco.CheckBoxList', '["a","b"]')).toEqual(['a', 'b'])
    expect(toEditorValue('Umbraco.MediaPicker3', 'not json')).toBe('not json')
    expect(toEditorValue('Umbraco.TextArea', '{"a":1}')).toBe('{"a":1}')
    expect(toEditorValue('Umbraco.TextBox', '42')).toBe('42')
  })
})
