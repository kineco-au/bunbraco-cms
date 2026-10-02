import { describe, expect, test } from 'bun:test'
import { findDuplicateOperationIds, listOperations, loadSpec, parsePath } from '@bunbraco/contracts'

/**
 * These counts pin the vendored contract to Umbraco release-18.2.0. If they
 * move, the contract was re-vendored from a different version — which is fine,
 * but it must be a deliberate, visible change.
 */
const EXPECTED = { paths: 428, operations: 513, schemas: 507 }

describe('vendored OpenAPI contract', () => {
  const spec = loadSpec()

  test('is OpenAPI 3.1.1 for the Umbraco Management API', () => {
    expect(spec.openapi).toBe('3.1.1')
    expect(spec.info.title).toBe('Umbraco Management API')
  })

  test('has the expected surface area', () => {
    const operations = listOperations(spec)
    expect(Object.keys(spec.paths)).toHaveLength(EXPECTED.paths)
    expect(operations).toHaveLength(EXPECTED.operations)
    expect(Object.keys(spec.components.schemas)).toHaveLength(EXPECTED.schemas)
  })

  test('has no duplicate operation ids', () => {
    // The generated client keys its methods on operationId, so a collision
    // silently drops an endpoint from the client.
    expect(findDuplicateOperationIds(listOperations(spec))).toEqual([])
  })

  test('every operation has an id, a version and an area', () => {
    for (const op of listOperations(spec)) {
      expect(op.operationId).toBeTruthy()
      expect(op.version).toBeTruthy()
      expect(op.area).toBeTruthy()
    }
  })

  test('parses the one v1.1 route without disturbing v1', () => {
    expect(parsePath('/umbraco/management/api/v1/document/{id}')).toEqual({
      version: '1',
      area: 'document',
    })
    expect(parsePath('/umbraco/management/api/v1.1/document/{id}/validate')).toEqual({
      version: '1.1',
      area: 'document',
    })
  })

  test('still contains the v1.1 validate operation under its pinned id', () => {
    // Renaming this operation shifts generated client method names.
    const op = listOperations(spec).find((o) => o.operationId === 'PutDocumentByIdValidate')
    expect(op).toBeDefined()
    expect(op?.version).toBe('1.1')
  })

  test('declares the boot-critical anonymous endpoints', () => {
    const ids = new Set(listOperations(spec).map((o) => o.operationId))
    expect(ids).toContain('GetServerStatus')
    expect(ids).toContain('GetServerConfiguration')
  })
})
