/**
 * The Bundles section in the backoffice: the views that replace Umbraco's, the
 * two labels its builder hard-codes, and the migrations that moved the stored
 * names. docs/17-bundles.md.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { formPermissionPrefixMigration, RENAMED_FORM_VERBS } from '@bunbraco/data'
import {
  BUILDER_LABELS,
  correctionFor,
} from '../packages/backoffice-host/plugin/branding/bundle-builder-labels.js'
import { type Harness, signedInServer } from './support/harness.ts'

const open: Harness[] = []
afterEach(async () => {
  while (open.length > 0)
    await open
      .pop()
      ?.db.close()
      .catch(() => {})
})

const PLUGIN = 'packages/backoffice-host/plugin'
const VENDOR = 'packages/backoffice-dist/dist/packages/packages'

describe('the Created view, which replaces a router', () => {
  test("reproduces every route Umbraco's own declares", async () => {
    // Umbraco's Created view is not a screen: it is the only thing that mounts
    // the builder workspace. A replacement that rendered a list would have left
    // the builder unreachable from anywhere in the backoffice.
    const theirs = await Bun.file(
      `${VENDOR}/package-section/views/created/created-packages-section-view.element.js`,
    ).text()
    const ours = await Bun.file(`${PLUGIN}/bundles-created.js`).text()
    // Upstream writes the catch-all as a template literal, so each route is
    // named twice: as it reads there, and as it reads here.
    const routes: Array<[string, string]> = [
      ["path: 'overview'", "path: 'overview'"],
      ['/edit/:unique', '/edit/:unique'],
      ['/create', '/create'],
      ["redirectTo: 'overview'", "redirectTo: 'overview'"],
      ['path: `**`', "path: '**'"],
    ]
    for (const [theirFragment, ourFragment] of routes) {
      expect([theirFragment, theirs.includes(theirFragment)]).toEqual([theirFragment, true])
      expect([ourFragment, ours.includes(ourFragment)]).toEqual([ourFragment, true])
    }
  })

  test('mounts the same workspace entity type the builder registers under', async () => {
    const manifests = await Bun.file(`${VENDOR}/package-builder/manifests.js`).text()
    expect(manifests).toContain("entityType: 'package-builder'")
    const ours = await Bun.file(`${PLUGIN}/bundles-created.js`).text()
    expect(ours).toContain("BUILDER_ENTITY_TYPE = 'package-builder'")
  })

  test('links to the builder at the path the section view is mounted on', async () => {
    // `pathname: 'created'` in the manifest and `section/packages` in the route
    // are the same two segments; a rename of either would break the link.
    const overview = await Bun.file(`${PLUGIN}/bundles-created-overview.js`).text()
    expect(overview).toContain("BUILDER_PATH = 'section/packages/view/created/package-builder'")
    const plugin = await Bun.file(`${PLUGIN}/umbraco-package.json`).json()
    const created = plugin.extensions.find(
      (e: { alias: string }) => e.alias === 'Bunbraco.SectionView.Bundles.Created',
    )
    expect(created.meta.pathname).toBe('created')
    expect(created.overwrites).toEqual(['Umb.SectionView.Packages.Builder'])
  })

  test('says bundle where Umbraco said package', async () => {
    const overview = await Bun.file(`${PLUGIN}/bundles-created-overview.js`).text()
    expect(overview).toContain('headline="Created bundles"')
    expect(overview).toContain('delete this bundle?')
    expect(overview).not.toContain('this package')
  })
})

describe("the builder's two hard-coded labels", () => {
  test('are still the strings the correction looks for', async () => {
    // The correction is a no-op if upstream reworded either, which is silent by
    // design — so this is the thing that notices a vendor bump.
    const builder = await Bun.file(
      `${VENDOR}/package-builder/workspace/workspace-package-builder.element.js`,
    ).text()
    for (const pair of BUILDER_LABELS) {
      const before = pair[0] as string
      expect([before, builder.includes(before)]).toEqual([before, true])
    }
  })

  test('map to bundle wording, and nothing else does', () => {
    expect(correctionFor('Name of the package')).toBe('Name of the bundle')
    expect(correctionFor('  Package Content  ')).toBe('Bundle content')
    expect(correctionFor('Name of the bundle')).toBeUndefined()
    expect(correctionFor('Package options')).toBeUndefined()
    expect(correctionFor(undefined)).toBeUndefined()
  })

  test('are applied to a shadow root the element owns', async () => {
    // Both strings are written by the builder's own template, so one query root
    // reaches them; a nested component would need its own.
    const builder = await Bun.file(
      `${VENDOR}/package-builder/workspace/workspace-package-builder.element.js`,
    ).text()
    expect(builder).toContain('id="package-name-input"')
    expect(builder).toContain('headline="Package Content"')
    expect(builder).toContain("customElement('umb-workspace-package-builder')")
  })
})

describe('migration 026, which re-prefixes the form verbs', () => {
  test('rewrites a stored Umb. verb to Bunbraco. and leaves others alone', async () => {
    const h = await signedInServer()
    open.push(h)
    const db = h.server.db
    const [group] = await db.query<{ key: string }>(
      "SELECT key FROM user_group WHERE alias = 'admin'",
    )
    if (!group) throw new Error('the admin group was not seeded')

    await db.exec('DELETE FROM user_group_permission WHERE permission = ?', ['Bunbraco.Form.Read'])
    await db.exec('INSERT INTO user_group_permission (user_group_key, permission) VALUES (?, ?)', [
      group.key,
      'Umb.Form.Read',
    ])

    await formPermissionPrefixMigration.up?.(db)

    const after = await db.query<{ permission: string }>(
      'SELECT permission FROM user_group_permission WHERE user_group_key = ? AND permission IN (?, ?)',
      [group.key, 'Umb.Form.Read', 'Bunbraco.Form.Read'],
    )
    expect(after.map((row) => row.permission)).toEqual(['Bunbraco.Form.Read'])
    // An Umbraco verb with a similar shape is untouched.
    const document = await db.query<{ n: number }>(
      "SELECT COUNT(*) AS n FROM user_group_permission WHERE permission = 'Umb.Document.Read'",
    )
    expect(Number(document[0]?.n ?? 0)).toBeGreaterThan(0)
  })

  test('leaves one row when a group somehow holds both spellings', async () => {
    const h = await signedInServer()
    open.push(h)
    const db = h.server.db
    const [group] = await db.query<{ key: string }>(
      "SELECT key FROM user_group WHERE alias = 'admin'",
    )
    if (!group) throw new Error('the admin group was not seeded')

    await db.exec('INSERT INTO user_group_permission (user_group_key, permission) VALUES (?, ?)', [
      group.key,
      'Umb.FormEntry.Sensitive',
    ])
    await formPermissionPrefixMigration.up?.(db)

    const rows = await db.query<{ permission: string }>(
      'SELECT permission FROM user_group_permission WHERE user_group_key = ? AND permission = ?',
      [group.key, 'Bunbraco.FormEntry.Sensitive'],
    )
    expect(rows).toHaveLength(1)
  })

  test('covers every verb the seed grants', () => {
    expect(RENAMED_FORM_VERBS.map(([before]) => before)).toEqual([
      'Umb.Form.Read',
      'Umb.Form.Manage',
      'Umb.FormEntry.Read',
      'Umb.FormEntry.Manage',
      'Umb.FormEntry.Sensitive',
    ])
    for (const [before, after] of RENAMED_FORM_VERBS) {
      expect([before, after]).toEqual([before, before.replace(/^Umb\./, 'Bunbraco.')])
    }
  })
})

describe('migration 027, which renames the table', () => {
  test('leaves the definitions in a table called bundle', async () => {
    const h = await signedInServer()
    open.push(h)
    const rows = await h.server.db.query<{ n: number }>('SELECT COUNT(*) AS n FROM bundle')
    expect(Number(rows[0]?.n ?? -1)).toBe(0)
    await expect(h.server.db.query('SELECT 1 FROM created_package')).rejects.toThrow()
  })
})
