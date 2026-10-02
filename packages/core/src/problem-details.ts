/**
 * RFC 7807 Problem Details as Umbraco emits them: `type` is the literal string
 * "Error", never a URI, plus Umbraco's own extension members.
 */
export interface ProblemDetails {
  type: string
  title: string
  status: number
  detail?: string
  instance?: string
  /** The domain operation status enum name, e.g. "NotFound". */
  operationStatus?: string
  /** Validation failures keyed by JSON path into the request model. */
  errors?: Record<string, string[]>
  invalidProperties?: string[]
  failedBranchItems?: Array<{ id: string; operationStatus: string }>
}

export const PROBLEM_TYPE = 'Error'

export function problemDetails(
  init: Omit<ProblemDetails, 'type'> & { type?: string },
): ProblemDetails {
  return { type: PROBLEM_TYPE, ...init }
}

export function problemResponse(problem: ProblemDetails, headers?: HeadersInit): Response {
  return new Response(JSON.stringify(problem), {
    status: problem.status,
    headers: { ...headers, 'content-type': 'application/problem+json; charset=utf-8' },
  })
}

export const notFound = (title = 'Not Found', detail?: string) =>
  problemDetails({ title, status: 404, detail, operationStatus: 'NotFound' })

export const unauthorized = (detail = 'Authentication is required.') =>
  problemDetails({ title: 'Unauthorized', status: 401, detail, operationStatus: 'Unauthorized' })

export const notImplemented = (operationId: string) =>
  problemDetails({
    title: 'Not implemented',
    status: 501,
    detail: `Operation '${operationId}' is declared in the contract but not implemented yet.`,
    operationStatus: 'NotImplemented',
  })

/**
 * Umbraco rejects a skip that is not a multiple of take, and the backoffice
 * relies on that contract when it pages.
 */
export const invalidSkipTake = () =>
  problemDetails({
    title: 'Invalid skip/take',
    detail: 'Skip must be a multiple of take - i.e. skip = 10, take = 5',
    status: 400,
  })
