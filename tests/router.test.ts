import { describe, expect, test } from 'bun:test'
import { ManagementApiRouter, type Principal } from '@bunbraco/api-management'
import { listOperations, loadSpec } from '@bunbraco/contracts'
import { CORE_SECTION_ALIASES, NOTIFICATIONS_HEADER, ROOT_ACCESS } from '@bunbraco/core'

const V1 = '/umbraco/management/api/v1'

const TEST_USER: Principal = {
  id: '00000000-0000-0000-0000-000000000000',
  userName: 'tester',
  name: 'Tester',
  email: 'tester@example.com',
  isAdmin: true,
  languageIsoCode: 'en-US',
  avatarUrls: [],
  allowedSections: [...CORE_SECTION_ALIASES],
  permissions: [],
  groupKeys: [],
  hasAccessToAllLanguages: true,
  languages: [],
  startNodes: { document: ROOT_ACCESS, media: ROOT_ACCESS, element: ROOT_ACCESS },
  groups: [],
}

/** A router where every request is authenticated, for testing routing itself. */
const signedIn = (options: { operations?: never } = {}) =>
  new ManagementApiRouter({ ...options, authenticate: async () => TEST_USER })

describe('ManagementApiRouter', () => {
  const router = signedIn()

  test('routes every operation declared in the contract', () => {
    const unroutable = listOperations(loadSpec()).filter((op) => {
      // Substitute a plausible value for each path parameter.
      const concrete = op.path.replace(/\{[^}]+\}/g, 'x')
      const matched = router.match(op.method, concrete)
      return matched?.operation.operationId !== op.operationId
    })
    expect(unroutable.map((o) => `${o.method} ${o.path}`)).toEqual([])
  })

  test('extracts path parameters', () => {
    const matched = router.match('get', `${V1}/document/2f8e1b0c-0000-0000-0000-000000000000`)
    expect(matched?.operation.operationId).toBe('GetDocumentById')
    expect(matched?.params.id).toBe('2f8e1b0c-0000-0000-0000-000000000000')
  })

  test('prefers the literal route over the parameterised one', () => {
    // /document/{id}/sort-children and /document/root/sort-children share a shape.
    const literal = router.match('put', `${V1}/document/root/sort-children`)
    expect(literal?.operation.operationId).toBe('PutDocumentRootSortChildren')
    const parameterised = router.match('put', `${V1}/document/abc/sort-children`)
    expect(parameterised?.operation.operationId).toBe('PutDocumentByIdSortChildren')
  })

  test('does not confuse methods', () => {
    expect(router.match('get', `${V1}/document/abc`)?.operation.operationId).toBe('GetDocumentById')
    expect(router.match('put', `${V1}/document/abc`)?.operation.operationId).toBe('PutDocumentById')
    expect(router.match('delete', `${V1}/document/abc`)?.operation.operationId).toBe(
      'DeleteDocumentById',
    )
  })

  test('answers 404 as Problem Details for a path outside the contract', async () => {
    const response = await router.dispatch(new Request(`http://localhost${V1}/not-a-thing`))
    expect(response.status).toBe(404)
    expect(response.headers.get('content-type')).toContain('application/problem+json')
    const body = await response.json()
    expect(body.type).toBe('Error')
    expect(body.status).toBe(404)
  })

  test('answers 501 for an operation that is in the contract but unimplemented', async () => {
    const response = await router.dispatch(new Request(`http://localhost${V1}/document/abc`))
    expect(response.status).toBe(501)
    const body = await response.json()
    expect(body.type).toBe('Error')
    expect(body.operationStatus).toBe('NotImplemented')
    expect(body.detail).toContain('GetDocumentById')
  })

  test('dispatches to a registered handler', async () => {
    // server/status is one of the 10 anonymous operations, so no authenticator.
    const scoped = new ManagementApiRouter().handle('GetServerStatus', () =>
      Response.json({ serverStatus: 'Run' }),
    )
    expect(scoped.implementedCount).toBe(1)
    expect(scoped.has('GetServerStatus')).toBe(true)
    const response = await scoped.dispatch(new Request(`http://localhost${V1}/server/status`))
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ serverStatus: 'Run' })
  })

  test('refuses to register an operation that is not in the contract', () => {
    expect(() => new ManagementApiRouter().handle('GetNonsense', () => new Response())).toThrow(
      /not in the contract/,
    )
  })

  describe('contract-driven authorisation', () => {
    test('rejects an unauthenticated request to a secured operation', async () => {
      const response = await new ManagementApiRouter().dispatch(
        new Request(`http://localhost${V1}/document/abc`),
      )
      expect(response.status).toBe(401)
      const body = await response.json()
      expect(body.type).toBe('Error')
      expect(body.operationStatus).toBe('Unauthorized')
    })

    test('allows an unauthenticated request to an anonymous operation', async () => {
      // The contract marks exactly 10 operations `security: []`.
      const response = await new ManagementApiRouter().dispatch(
        new Request(`http://localhost${V1}/server/status`),
      )
      expect(response.status).toBe(501)
    })

    test('passes the principal to the handler', async () => {
      let seen: Principal | undefined
      const scoped = signedIn().handle('GetDocumentById', ({ principal }) => {
        seen = principal
        return new Response(null, { status: 204 })
      })
      await scoped.dispatch(new Request(`http://localhost${V1}/document/abc`))
      expect(seen).toEqual(TEST_USER)
    })

    test('marks the expected operations anonymous, and only those', () => {
      const anonymous = listOperations(loadSpec())
        .filter((o) => o.anonymous)
        .map((o) => o.operationId)
        .sort()
      expect(anonymous).toEqual([
        'DeletePreview',
        'GetInstallSettings',
        'GetManifestManifestPublic',
        'GetServerConfiguration',
        'GetServerStatus',
        'PostInstallSetup',
        'PostInstallValidateDatabase',
        'PostSecurityForgotPasswordVerify',
        'PostUserInviteCreatePassword',
        'PostUserInviteVerify',
      ])
    })
  })

  test('sets no-store on every response', async () => {
    const response = await router.dispatch(new Request(`http://localhost${V1}/document/abc`))
    expect(response.headers.get('cache-control')).toBe('no-store')
  })

  describe('Umb-Notifications header', () => {
    const withNotification = (operationId: string) =>
      signedIn().handle(operationId, ({ notifications }) => {
        notifications.push({ message: 'Saved', category: 'Content', type: 'Success' })
        return new Response(null, { status: 200 })
      })

    test('is set on a non-GET response', async () => {
      const router = withNotification('PutDocumentById')
      const response = await router.dispatch(
        new Request(`http://localhost${V1}/document/abc`, { method: 'PUT' }),
      )
      const header = response.headers.get(NOTIFICATIONS_HEADER)
      expect(header).toBeTruthy()
      expect(JSON.parse(header as string)).toEqual([
        { message: 'Saved', category: 'Content', type: 'Success' },
      ])
    })

    test('is never set on a GET response, even when messages were queued', async () => {
      const router = withNotification('GetDocumentById')
      const response = await router.dispatch(new Request(`http://localhost${V1}/document/abc`))
      expect(response.headers.get(NOTIFICATIONS_HEADER)).toBeNull()
    })

    test('uses the Umb- name, not Umbraco-', () => {
      expect(NOTIFICATIONS_HEADER).toBe('Umb-Notifications')
    })
  })
})
