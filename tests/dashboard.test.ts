/**
 * The framework's backoffice package: the Changes dashboard and the read-only
 * banner are served and registered like any installed npm extension, and read a
 * report endpoint that a development boot fills. Proved by its endpoint and
 * its manifest, not by clicking it. docs/10, "The upgrade dashboard ships in the first release".
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ContentTypeRepository, connect, readLedger, writeReport } from '@bunbraco/data'
import { dialectUnderTest } from './support/db.ts'
import { BACKOFFICE, type Harness, signedInServer, V1 } from './support/harness.ts'

const open: Harness[] = []
const dirs: string[] = []
afterEach(async () => {
  while (open.length > 0)
    await open
      .pop()
      ?.db.close()
      .catch(() => {})
  while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true })
})

const ARTICLE = (extra: string) => `[document-type]
key = "0b1c8e3a-4444-4a5b-9c1d-000000000001"
alias = "article"
name = "Article"
allow-at-root = true

[[property]]
key = "0b1c8e3a-4444-4a5b-9c1d-000000000002"
alias = "title"
name = "Title"
type = "textstring"
${extra}`

const REQUIRED_SUMMARY = `
[[property]]
key = "0b1c8e3a-4444-4a5b-9c1d-000000000003"
alias = "summary"
name = "Summary"
type = "textarea"
mandatory = true
`

function site(version: string, extra: string) {
  const root = mkdtempSync(join(process.cwd(), 'output', 'dashboard-'))
  dirs.push(root)
  mkdirSync(join(root, 'schema', 'document-types'), { recursive: true })
  mkdirSync(join(root, 'components'), { recursive: true })
  writeFileSync(join(root, 'schema', 'schema.toml'), `[schema]\nversion = "${version}"\n`)
  writeFileSync(join(root, 'schema', 'document-types', 'article.toml'), ARTICLE(extra))
  return {
    root,
    schemaDir: join(root, 'schema'),
    componentsDir: join(root, 'components'),
    sqliteFile: join(root, 'site.sqlite'),
  }
}

describe(`changes dashboard (${dialectUnderTest})`, () => {
  test('the framework package is in the manifests and its modules are served', async () => {
    const h = await signedInServer()
    open.push(h)
    const manifests = await h.json<
      Array<{
        name: string
        extensions: Array<{
          type: string
          alias: string
          element?: string
          js?: string
          api?: string
          overwrites?: string[]
        }>
      }>
    >(`${V1}/manifest/manifest`)
    const ours = manifests.find((m) => m.name === 'Bunbraco')
    expect(ours).toBeDefined()
    const aliases = ours?.extensions.map((e) => `${e.type}:${e.alias}`) ?? []
    expect(aliases).toEqual([
      'sectionView:Bunbraco.SectionView.Bundles.Marketplace',
      'sectionView:Bunbraco.SectionView.Bundles.Created',
      'sectionView:Bunbraco.SectionView.Bundles.Installed',
      'dashboard:Bunbraco.Dashboard.Changes',
      'dashboard:Bunbraco.Dashboard.Welcome',
      'dashboard:Bunbraco.Dashboard.Settings',
      'backofficeEntryPoint:Bunbraco.EntryPoint.TsxEditors',
      'headerApp:Bunbraco.HeaderApp.ReadOnly',
      'workspaceFooterApp:Bunbraco.WorkspaceFooterApp.ElementTypeHint',
      'localization:Bunbraco.Localization.EN',
      'localization:Bunbraco.Localization.EN_US',
      'backofficeEntryPoint:Bunbraco.EntryPoint.Branding',
      'backofficeEntryPoint:Bunbraco.EntryPoint.HelpMenu',
      'backofficeEntryPoint:Bunbraco.EntryPoint.Sysinfo',
      'section:Bunbraco.Section.Forms',
      'sectionView:Bunbraco.SectionView.Forms.Overview',
      'sectionView:Bunbraco.SectionView.Forms.Entries',
      'propertyEditorSchema:Bunbraco.FormPicker',
      'propertyEditorUi:Bunbraco.PropertyEditorUi.FormPicker',
      'backofficeEntryPoint:Bunbraco.EntryPoint.ClientCredentials',
      'backofficeEntryPoint:Bunbraco.EntryPoint.BundleBuilderLabels',
      // One tree over components/, in place of Templates and Partial Views.
      'backofficeEntryPoint:Bunbraco.EntryPoint.ComponentsTree',
      // The query builder writes TypeScript, so its code block says so.
      'backofficeEntryPoint:Bunbraco.EntryPoint.QueryBuilder',
      // The sign-in button, in place of Umbraco's "Sign in with Umbraco".
      'backofficeEntryPoint:Bunbraco.EntryPoint.SignIn',
      // The log message menu, aimed at this project rather than Umbraco's.
      'backofficeEntryPoint:Bunbraco.EntryPoint.LogViewerMenu',
      // Keeps the Umbraco mark out of the icon picker.
      'globalContext:Bunbraco.GlobalContext.Icons',
    ])
    // The welcome dashboard takes the place of Umbraco's news dashboard through
    // the registry's own `overwrites`, rather than mutating it while rendering.
    const welcome = ours?.extensions.find((e) => e.alias === 'Bunbraco.Dashboard.Welcome')
    expect(welcome?.overwrites).toEqual(['Umb.Dashboard.UmbracoNews'])
    // All three Bundles views replace Umbraco's: its Marketplace is an iframe of
    // a site that refuses to be framed, its Installed view is built around
    // package migrations, which cannot exist here, and its Created view is a
    // router whose overview says package (`docs/17-bundles.md`).
    const marketplace = ours?.extensions.find(
      (e) => e.alias === 'Bunbraco.SectionView.Bundles.Marketplace',
    )
    expect(marketplace?.overwrites).toEqual(['Umb.SectionView.Packages.Marketplace'])
    const installed = ours?.extensions.find(
      (e) => e.alias === 'Bunbraco.SectionView.Bundles.Installed',
    )
    expect(installed?.overwrites).toEqual(['Umb.SectionView.Packages.Installed'])
    const created = ours?.extensions.find((e) => e.alias === 'Bunbraco.SectionView.Bundles.Created')
    expect(created?.overwrites).toEqual(['Umb.SectionView.Packages.Builder'])
    // Two kinds of extension have no module of their own: a `section`, which is
    // a route and a label, and a `propertyEditorSchema`, which declares a
    // server-side editor alias and its default UI. Everything else loads one,
    // under `element`, `js`, or — for a context class — `api`.
    const moduleless = ours?.extensions.filter((e) => !e.element && !e.js && !e.api) ?? []
    expect(moduleless.map((e) => e.alias)).toEqual([
      'Bunbraco.Section.Forms',
      'Bunbraco.FormPicker',
    ])
    expect(moduleless.map((e) => e.type)).toEqual(['section', 'propertyEditorSchema'])

    // Module paths follow the backoffice mount and resolve to real modules
    for (const extension of ours?.extensions ?? []) {
      const path = (extension.element ?? extension.js ?? extension.api) as string | undefined
      if (!path) continue
      expect(path.startsWith(`${BACKOFFICE}/bunbraco/`)).toBe(true)
      const response = await h.call(path)
      expect(response.status).toBe(200)
      expect(response.headers.get('content-type')).toContain('javascript')
      // What a module must export follows what kind of extension it is: an element
      // defines one, a context exports the class as `api`, an entry point runs
      // `onInit`, and a localization is a dictionary.
      const expected = extension.element
        ? 'customElements.define'
        : extension.api
          ? ' as api }'
          : extension.type === 'localization'
            ? 'export default'
            : 'export const onInit'
      expect(await response.text(), `${extension.alias} exports ${expected}`).toContain(expected)
    }
    expect((await h.call(`${BACKOFFICE}/bunbraco/report-client.js`)).status).toBe(200)
    expect((await h.call(`${BACKOFFICE}/bunbraco/../package.json`)).status).not.toBe(200)
  })

  test('the report endpoint needs a session, and a development boot fills it with what the schema needs', async () => {
    const s = site('1.0.0', '')
    const first = await signedInServer({
      config: {
        schemaDir: s.schemaDir,
        componentsDir: s.componentsDir,
        sqliteFile: s.sqliteFile,
        development: true,
        nodeId: 'dev',
      },
    })
    open.push(first)
    const typeKey = (await new ContentTypeRepository(first.server.db).byAlias('article'))
      ?.key as string
    for (const name of ['One', 'Two']) {
      const created = await first.post(`${V1}/document`, {
        documentType: { id: typeKey },
        template: null,
        parent: null,
        values: [{ alias: 'title', culture: null, segment: null, value: name }],
        variants: [{ culture: null, segment: null, name }],
      })
      expect(created.status).toBe(201)
      const key = created.headers.get('umb-generated-resource') as string
      expect(
        (await first.put(`${V1}/document/${key}/publish`, { publishSchedules: [] })).status,
      ).toBe(200)
    }
    const anonymous = await first.server.fetch(
      new Request(`http://localhost${BACKOFFICE}/bunbraco/api/change-report`),
    )
    expect(anonymous.status).toBe(401)
    const empty = await first.json<{ counts: Record<string, number>; findings: unknown[] }>(
      `${BACKOFFICE}/bunbraco/api/change-report`,
    )
    expect(empty.findings).toEqual([])
    await first.db.close()
    open.pop()

    // A bundle was checked against this site before the restart. The boot below
    // writes its own findings, and a run resolves whatever it does not report —
    // so without the source scoping this would silently clear the bundle's
    // report on every dev server restart, which is the failure nobody would see.
    const between = await connect({ file: s.sqliteFile })
    await writeReport(
      between,
      [
        {
          kind: 'person',
          code: 'local-edit',
          subjectType: 'document',
          subjectKey: 'doc-b',
          subjectName: 'Landing',
          propertyAlias: null,
          culture: null,
          message: 'edited here since the bundle was exported',
          link: null,
        },
      ],
      { source: 'transfer', scope: 'campaign-x' },
    )
    await between.close()

    // The developer adds a required property and restarts: pending-allowed, so boot proceeds and reports
    writeFileSync(join(s.schemaDir, 'document-types', 'article.toml'), ARTICLE(REQUIRED_SUMMARY))
    writeFileSync(join(s.schemaDir, 'schema.toml'), '[schema]\nversion = "1.1.0"\n')
    const second = await signedInServer({
      keepDatabase: true,
      config: {
        schemaDir: s.schemaDir,
        componentsDir: s.componentsDir,
        sqliteFile: s.sqliteFile,
        development: true,
        nodeId: 'dev',
      },
    })
    open.push(second)
    expect(second.server.schema.report?.action).toBe('applied')
    // The boot already applied the change, so the diff is empty; the unfilled pages remain
    expect(second.server.schema.check?.classification).toBe('none')
    const report = await second.json<{
      health: { ok: boolean; readOnly: boolean; version: string }
      counts: Record<string, number>
      bySource: Record<string, Record<string, number>>
      findings: Array<{
        kind: string
        code: string
        source: string
        scope: string | null
        subjectName: string
        link: string | null
        status: string
      }>
    }>(`${BACKOFFICE}/bunbraco/api/change-report`)
    expect(report.health).toMatchObject({ ok: true, readOnly: false, version: '1.1.0' })
    // The boot's two findings, plus the bundle's — which it neither reported nor
    // resolved. The dashboard separates them by source rather than pooling them.
    expect(report.counts).toEqual({ person: 3 })
    expect(report.bySource).toEqual({ upgrade: { person: 2 }, transfer: { person: 1 } })
    expect(report.findings.map((f) => [f.source, f.code, f.subjectName, f.status])).toEqual([
      ['transfer', 'local-edit', 'Landing', 'open'],
      ['upgrade', 'mandatory-unfilled', 'One', 'open'],
      ['upgrade', 'mandatory-unfilled', 'Two', 'open'],
    ])
    expect(report.findings.find((f) => f.code === 'local-edit')?.scope).toBe('campaign-x')
    expect(report.findings.find((f) => f.code === 'mandatory-unfilled')?.link).toMatch(
      new RegExp(`^${BACKOFFICE}/section/content/workspace/document/edit/`),
    )
  })

  test('production boot refuses a schema change that needs data work, naming the command', async () => {
    if (dialectUnderTest !== 'sqlite') return
    const s = site('1.0.0', '')
    const config = {
      schemaDir: s.schemaDir,
      componentsDir: s.componentsDir,
      sqliteFile: s.sqliteFile,
      development: false,
      schemaWritable: false,
      nodeId: 'prod',
    }
    const live = await signedInServer({ config })
    open.push(live)
    const typeKey = (await new ContentTypeRepository(live.server.db).byAlias('article'))
      ?.key as string
    await live.post(`${V1}/document`, {
      documentType: { id: typeKey },
      template: null,
      parent: null,
      values: [{ alias: 'title', culture: null, segment: null, value: 'Page' }],
      variants: [{ culture: null, segment: null, name: 'Page' }],
    })
    await live.db.close()
    open.pop()

    writeFileSync(join(s.schemaDir, 'document-types', 'article.toml'), ARTICLE(REQUIRED_SUMMARY))
    writeFileSync(join(s.schemaDir, 'schema.toml'), '[schema]\nversion = "1.1.0"\n')
    const { createServer, loadConfig, UpgradeRequiredError } = await import('@bunbraco/server')
    let failure: unknown
    try {
      const server = await createServer(loadConfig(config))
      await server.close()
    } catch (error) {
      failure = error
    }
    expect(failure).toBeInstanceOf(UpgradeRequiredError)
    expect((failure as Error).message).toContain('bunbraco upgrade check')
    // An additive change (an optional property) rolls out at boot as before
    writeFileSync(
      join(s.schemaDir, 'document-types', 'article.toml'),
      ARTICLE(REQUIRED_SUMMARY.replace('mandatory = true\n', '')),
    )
    const rolled = await signedInServer({ keepDatabase: true, config })
    open.push(rolled)
    expect(rolled.server.schema.report?.action).toBe('applied')
    expect((await readLedger(rolled.server.db)).some((r) => r.kind === 'upgrade')).toBe(false)
  })
})
