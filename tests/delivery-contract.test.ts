/**
 * Story 050: Umbraco's Delivery API contract, vendored from release-18.2.0's
 * expected generic contract. If these counts move, it was re-vendored from
 * another version — fine, but deliberate.
 */
import { describe, expect, test } from 'bun:test'
import { findDuplicateOperationIds, listOperations, loadDeliverySpec } from '@crombolo/contracts'

describe('the vendored Delivery API contract', () => {
  const spec = loadDeliverySpec()

  test('is OpenAPI 3.1.1 for the Umbraco Delivery API', () => {
    expect(spec.openapi).toBe('3.1.1')
    expect(spec.info.title).toBe('Umbraco Delivery API')
  })

  test('has the eight content and media operations, at v2', () => {
    const operations = listOperations(spec)
    expect(operations.map((op) => op.operationId).sort()).toEqual([
      'GetContent2.0',
      'GetContentItemById2.0',
      'GetContentItemByPath2.0',
      'GetContentItems2.0',
      'GetMedia2.0',
      'GetMediaItemById2.0',
      'GetMediaItemByPath2.0',
      'GetMediaItems2.0',
    ])
    expect(new Set(operations.map((op) => op.version))).toEqual(new Set(['2']))
    expect(Object.keys(spec.components.schemas)).toHaveLength(10)
    expect(findDuplicateOperationIds(operations)).toEqual([])
  })
})

describe('the Delivery API serves its contract', () => {
  test('every operation is answered by the handler, as coverage:api counts it', async () => {
    const { createDeliveryApi, deliveryCoverage, resolveDeliveryApiSettings } = await import(
      '@crombolo/api-delivery'
    )
    const { PublishedCache } = await import('@crombolo/render')
    const coverage = await deliveryCoverage(
      createDeliveryApi({
        settings: resolveDeliveryApiSettings({ enabled: true, media: { enabled: true } }),
        cache: new PublishedCache({ loadPublished: async () => [] }),
        prefix: '/umbraco/delivery/api',
        protection: async () => [],
        member: async () => undefined,
      }),
    )
    expect(coverage.served.size).toBe(coverage.operations.length)
  })
})
