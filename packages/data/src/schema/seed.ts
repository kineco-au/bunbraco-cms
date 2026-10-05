/**
 * Install seed data, mirroring Umbraco's DatabaseDataCreator.
 *
 * Password hashing is injected rather than imported so this package stays free of
 * a dependency on @bunbraco/auth.
 */
import type { Db } from '../database.ts'
import { DbDate } from '../dialect.ts'

const ELEMENT_EDIT = [
  'Umb.Element.Create',
  'Umb.Element.Update',
  'Umb.Element.Delete',
  'Umb.Element.Move',
  'Umb.Element.Duplicate',
  'Umb.Element.Publish',
  'Umb.Element.Unpublish',
  'Umb.Element.Read',
  'Umb.Element.Rollback',
  'Umb.ElementContainer.Create',
  'Umb.ElementContainer.Update',
  'Umb.ElementContainer.Delete',
  'Umb.ElementContainer.Move',
  'Umb.ElementContainer.Read',
]

/**
 * The permission verbs each built-in group is installed with — Umbraco's
 * `DatabaseDataCreator.CreateUserGroup2PermissionData`, verbatim, including the
 * legacy single-character letters it still seeds. The backoffice reads these
 * as the user's fallback permissions; without them it hides every
 * permission-gated action, Create included.
 */
/** Everything about forms, which only an administrator gets by default. */
const FORM_FULL = [
  'Bunbraco.Form.Read',
  'Bunbraco.Form.Manage',
  'Bunbraco.FormEntry.Read',
  'Bunbraco.FormEntry.Manage',
  'Bunbraco.FormEntry.Sensitive',
] as const

export const BUILT_IN_GROUP_PERMISSIONS: Record<string, readonly string[]> = {
  admin: [
    'Umb.Document.Create',
    'Umb.Document.Update',
    'Umb.Document.Delete',
    'Umb.Document.Move',
    'Umb.Document.Duplicate',
    'Umb.Document.Sort',
    'Umb.Document.Rollback',
    'Umb.Document.PublicAccess',
    'Umb.Document.CultureAndHostnames',
    'Umb.Document.Publish',
    'Umb.Document.Permissions',
    'Umb.Document.Unpublish',
    'Umb.Document.Read',
    'Umb.Document.CreateBlueprint',
    'Umb.Document.Notifications',
    ':',
    '5',
    '7',
    'T',
    'Umb.Document.PropertyValue.Read',
    'Umb.Document.PropertyValue.Write',
    ...FORM_FULL,
    ...ELEMENT_EDIT,
  ],
  editor: [
    'Umb.Document.Create',
    'Umb.Document.Update',
    'Umb.Document.Delete',
    'Umb.Document.Move',
    'Umb.Document.Duplicate',
    'Umb.Document.Sort',
    'Umb.Document.Rollback',
    'Umb.Document.PublicAccess',
    'Umb.Document.Publish',
    'Umb.Document.Unpublish',
    'Umb.Document.Read',
    'Umb.Document.CreateBlueprint',
    'Umb.Document.Notifications',
    ':',
    '5',
    'T',
    'Umb.Document.PropertyValue.Read',
    'Umb.Document.PropertyValue.Write',
    // An editor reads entries and acts on them, but does not design forms and
    // does not see what a definition marks sensitive.
    'Bunbraco.Form.Read',
    'Bunbraco.FormEntry.Read',
    'Bunbraco.FormEntry.Manage',
    ...ELEMENT_EDIT,
  ],
  writer: [
    'Umb.Document.Create',
    'Umb.Document.Update',
    'Umb.Document.Read',
    'Umb.Document.Notifications',
    ':',
    'Umb.Document.PropertyValue.Read',
    'Umb.Document.PropertyValue.Write',
    'Umb.Element.Create',
    'Umb.Element.Update',
    'Umb.Element.Read',
    'Umb.ElementContainer.Create',
    'Umb.ElementContainer.Update',
    'Umb.ElementContainer.Read',
  ],
  // The group that exists only to carry sensitive-data access; it has no
  // sections of its own and is added alongside another group.
  sensitiveData: ['Bunbraco.FormEntry.Sensitive'],
  translator: [
    'Umb.Document.Update',
    'Umb.Document.Read',
    'Umb.Document.PropertyValue.Read',
    'Umb.Document.PropertyValue.Write',
    'Umb.Element.Update',
    'Umb.Element.Read',
    'Umb.ElementContainer.Update',
    'Umb.ElementContainer.Read',
  ],
}

/**
 * Grants each built-in group its default verbs where it lacks them. Plannable
 * (no reads) and idempotent; used by the seed and by migration 007.
 */
export async function grantBuiltInPermissions(db: Db): Promise<void> {
  for (const [alias, permissions] of Object.entries(BUILT_IN_GROUP_PERMISSIONS)) {
    for (const permission of permissions) {
      await db.exec(
        `INSERT INTO user_group_permission (user_group_key, permission)
         SELECT g.key, ? FROM user_group g
         WHERE g.alias = ? AND NOT EXISTS (
           SELECT 1 FROM user_group_permission p WHERE p.user_group_key = g.key AND p.permission = ?
         )`,
        [permission, alias, permission],
      )
    }
  }
}

/** Umbraco's five built-in groups, key for key, with their seeded section access. */
export const BUILT_IN_GROUPS = [
  {
    id: 1,
    key: 'e5e7f6c8-7f9c-4b5b-8d5d-9e1e5a4f7e4d',
    alias: 'admin',
    name: 'Administrators',
    icon: 'icon-medal',
    hasAccessToAllLanguages: true,
    sections: [
      'content',
      'packages',
      'media',
      'members',
      'settings',
      'users',
      'forms',
      'translation',
      'library',
    ],
  },
  {
    id: 2,
    key: '9fc2a16f-528c-46d6-a014-75bf4ec2480c',
    alias: 'writer',
    name: 'Writers',
    icon: 'icon-edit',
    hasAccessToAllLanguages: true,
    sections: ['content', 'library'],
  },
  {
    id: 3,
    key: '44dc260e-b4d4-4dd9-9081-eec5598f1641',
    alias: 'editor',
    name: 'Editors',
    icon: 'icon-tools',
    hasAccessToAllLanguages: true,
    sections: ['content', 'media', 'forms', 'library'],
  },
  {
    id: 4,
    key: 'f2012e4c-d232-4bd1-8eae-4384032d97d8',
    alias: 'translator',
    name: 'Translators',
    icon: 'icon-globe',
    hasAccessToAllLanguages: true,
    sections: ['translation'],
  },
  {
    id: 5,
    key: '8c6ad70f-d307-4e4a-af58-72c2e4e9439d',
    alias: 'sensitiveData',
    name: 'Sensitive data',
    icon: 'icon-lock',
    hasAccessToAllLanguages: false,
    sections: [],
  },
] as const

/** Umbraco's super user: the installer's administrator, whom only they can see in the user lists. */
export const SUPER_USER_KEY = '1e70f841-c261-413b-abb2-2d68cdb96094'

export interface SeedAdmin {
  name: string
  login: string
  email: string
  password: string
}

export interface SeedOptions {
  admin: SeedAdmin
  hashPassword: (password: string) => Promise<string>
  passwordConfig: string
}

async function tableIsEmpty(db: Db, table: string): Promise<boolean> {
  const rows = await db.query<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`)
  return Number(rows[0]?.n ?? 0) === 0
}

/** Idempotent: does nothing when the identity tables already hold data. */
export async function seedIdentity(db: Db, options: SeedOptions): Promise<boolean> {
  if (!(await tableIsEmpty(db, 'user_group'))) return false

  const now = DbDate.toDb(new Date())
  const bool = (value: boolean) => db.dialect.boolValue(value)

  for (const group of BUILT_IN_GROUPS) {
    await db.exec(
      `INSERT INTO user_group
         (id, key, alias, name, icon, has_access_to_all_languages,
          start_content_id, start_media_id, start_element_id, create_date, update_date)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        group.id,
        group.key,
        group.alias,
        group.name,
        group.icon,
        bool(group.hasAccessToAllLanguages),
        -1,
        -1,
        -1,
        now,
        now,
      ],
    )
    for (const section of group.sections) {
      await db.exec('INSERT INTO user_group_section (user_group_id, app_alias) VALUES (?, ?)', [
        group.id,
        section,
      ])
    }
  }
  const sync = db.dialect.syncIdentity('user_group')
  if (sync) await db.exec(sync)
  await grantBuiltInPermissions(db)

  await db.exec(
    `INSERT INTO user_account
       (key, user_name, login, email, password_hash, password_config, security_stamp, language,
        kind, is_locked_out, is_approved, failed_login_attempts, create_date, update_date)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      SUPER_USER_KEY,
      options.admin.name,
      options.admin.login,
      options.admin.email,
      await options.hashPassword(options.admin.password),
      options.passwordConfig,
      crypto.randomUUID(),
      'en-US',
      0,
      bool(false),
      bool(true),
      0,
      now,
      now,
    ],
  )

  const created = await db.query<{ id: number }>('SELECT id FROM user_account WHERE login = ?', [
    options.admin.login,
  ])
  const userId = Number(created[0]?.id)

  // Umbraco puts the super user in Administrators and Sensitive data.
  for (const groupId of [1, 5]) {
    await db.exec('INSERT INTO user_group_member (user_id, user_group_id) VALUES (?, ?)', [
      userId,
      groupId,
    ])
  }
  return true
}
