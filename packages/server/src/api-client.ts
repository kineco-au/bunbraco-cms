/**
 * The API client an unattended install seeds (story 034): an API user in the
 * administrators group, holding the configured client, so a pipeline can sign
 * in with the client-credentials grant on a site whose backoffice only takes an
 * identity provider. Created once; a client that exists is never rotated from
 * config. `docs/operations.md`.
 */
import { hashPassword } from '@crombolo/auth'
import { ADMIN_GROUP_ALIAS } from '@crombolo/core'
import { BUILT_IN_GROUPS, closeSetup, type Db, UserRepository } from '@crombolo/data'
import { recordAudit } from './adapters/audit.ts'

/** Seeds the client when no user holds its id; `existed` when one already does. */
export async function ensureApiClient(
  db: Db,
  client: { id: string; secret: string },
): Promise<'created' | 'existed'> {
  const users = new UserRepository(db)
  if (await users.clientCredentialOwner(client.id)) {
    // A machine can already administer the site, so the browser setup step goes.
    await closeSetup(db)
    return 'existed'
  }
  const admins = BUILT_IN_GROUPS.find((group) => group.alias === ADMIN_GROUP_ALIAS)
  const created = await users.create({
    key: crypto.randomUUID(),
    name: 'API client',
    userName: client.id,
    email: '',
    kind: 'Api',
    groupKeys: admins ? [admins.key] : [],
    languageIsoCode: null,
  })
  if (!created) throw new Error(`The API client ${client.id} could not be created.`)
  await users.addClientCredential(created.id, client.id, await hashPassword(client.secret))
  await closeSetup(db)
  await recordAudit(db, {
    category: 'user',
    action: 'Create',
    source: 'cli',
    entityType: 'User',
    entityKey: created.key,
    entityName: client.id,
    detail: 'API client seeded from CROMBOLO_API_CLIENT_ID',
  })
  return 'created'
}
