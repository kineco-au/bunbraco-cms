/**
 * `server.role`: what each registered node serves, so the cluster can be read
 * back by role — which nodes are answering the public site, which the editor.
 */
import type { Db } from '../database.ts'
import type { Migration } from '../migrations.ts'
import { schemaOps } from '../schema-ops.ts'
import { STATE_CLIENT_ID_PREFIX } from './client-id-prefix.ts'

export const STATE_SERVER_ROLE = '{6f1d4a8e-0021-4c21-9d3a-8b1e5c7a2f21}'

export const serverRoleMigration: Migration = {
  from: STATE_CLIENT_ID_PREFIX,
  to: STATE_SERVER_ROLE,
  name: 'AddServerRole',
  kind: 'expand',
  release: '0.4.0',
  async up(db: Db) {
    await schemaOps(db).addColumn('server', 'role', db.dialect.types.varchar(20))
  },
}
