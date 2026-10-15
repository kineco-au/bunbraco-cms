/**
 * How much of the Delivery API contract is served, found by asking: each
 * operation is sent to the handler with placeholder parameters, and counts
 * when the handler answers it at all rather than passing it on.
 */
import { listOperations, loadDeliverySpec, type OperationInfo } from '@crombolo/contracts'
import type { DeliveryApi } from './handler.ts'

/** A request for an operation, its path parameters filled with placeholders. Pure. */
export function probeFor(op: OperationInfo, origin = 'http://localhost'): Request {
  const path = op.path
    .replace('{id}', '00000000-0000-4000-8000-000000000001')
    .replace('{path}', 'probe')
  return new Request(`${origin}${path}`, { method: op.method.toUpperCase() })
}

export async function deliveryCoverage(
  api: DeliveryApi,
): Promise<{ operations: OperationInfo[]; served: Set<string> }> {
  const operations = listOperations(loadDeliverySpec())
  const served = new Set<string>()
  for (const op of operations) {
    const response = await api.handle(probeFor(op))
    if (response && response.status !== 501) served.add(op.operationId)
  }
  return { operations, served }
}
