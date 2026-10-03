/**
 * `bunbraco import umbraco`: an Umbraco backup in, a report and a bunbraco site
 * out.
 *
 * Everything runs against a real export — the Umbraco Commerce demo store, an
 * Umbraco 17 site with a package installed, third-party property editors and a
 * layout chain — because the conversions that matter are the ones a made-up
 * database would not think to include.
 */
import { Database } from 'bun:sqlite'
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DocumentRepository } from '@bunbraco/data'
import {
  componentName,
  type ImportPlan,
  MINIMUM_MAJOR,
  openSource,
  planImport,
  reportMarkdown,
  UPGRADE_STATES,
  versionForState,
  viewStub,
} from '@bunbraco/import-umbraco'
import { loadSchemaDirectory, validateSchemaSet } from '@bunbraco/schema'
import { templateAliasesIn } from '@bunbraco/server'
import { type BundleNode, importBundle, loadBundle } from '@bunbraco/transfer'
import { canConnect, dialectUnderTest } from './support/db.ts'
import { type Harness, signedInServer } from './support/harness.ts'
import { DEMO_STORE, writePlan } from './support/umbraco-import.ts'

const work = mkdtempSync(join(process.cwd(), 'output', 'import-umbraco-'))
afterAll(() => rmSync(work, { recursive: true, force: true }))

/** The staging database the fixture converts to, kept so tests can alter copies of it. */
const staging = join(work, 'staging.sqlite')
let plan: ImportPlan
let site: string

beforeAll(async () => {
  plan = await planImport({ source: DEMO_STORE, staging })
  site = join(work, 'site')
  await writePlan(site, plan)
})

const finding = (p: ImportPlan, code: string) => p.report.findings.filter((f) => f.code === code)
const node = (p: ImportPlan, name: string, kind: BundleNode['kind'] = 'document'): BundleNode => {
  const nodes = p.files
    .filter((f) => f.path.startsWith('bundles/umbraco-import/nodes/'))
    .map((f) => JSON.parse(f.text as string) as BundleNode)
  return nodes.find((n) => n.kind === kind && n.variants[0]?.name === name) as BundleNode
}
/** A value by page name and property; two pages can share a name, so the one with the property is meant. */
const storedValue = (p: ImportPlan, name: string, property: string) =>
  p.files
    .filter((f) => f.path.startsWith('bundles/umbraco-import/nodes/'))
    .map((f) => JSON.parse(f.text as string) as BundleNode)
    .filter((n) => n.variants[0]?.name === name)
    .flatMap((n) => n.values)
    .find((v) => v.property === property)
const fileText = (p: ImportPlan, path: string) => p.files.find((f) => f.path === path)?.text

/** A copy of the staging database, altered, as a native Umbraco SQLite backup would arrive. */
function alteredCopy(name: string, alter: (db: Database) => void): string {
  const path = join(work, `${name}.sqlite`)
  cpSync(staging, path)
  const db = new Database(path)
  alter(db)
  db.close()
  return path
}

describe('detecting the Umbraco version', () => {
  test('reads it from the upgrade state the database records', () => {
    expect(plan.report.umbraco).toEqual({
      version: '17.0.0',
      major: 17,
      state: '1c38d589-26bb-4a46-9abe-e4a0df548a87',
      status: 'supported',
    })
  })

  test('knows every state from 10 to 18, in any spelling', () => {
    expect(UPGRADE_STATES.length).toBe(86)
    expect(new Set(UPGRADE_STATES.map(([state]) => state)).size).toBe(86)
    expect(versionForState('{1C38D589-26BB-4A46-9ABE-E4A0DF548A87}')).toBe('17.0.0')
    expect(versionForState('ae533af6-4611-4e25-aa4d-89aefa468e79')).toBe('18.1.0')
    expect(versionForState('00000000-0000-0000-0000-000000000000')).toBeUndefined()
    const majors = new Set(UPGRADE_STATES.map(([, version]) => Number(version.split('.')[0])))
    expect([...majors]).toEqual([10, 11, 12, 13, 14, 15, 16, 17, 18])
  })

  test('a site older than the minimum is refused, with nothing written', async () => {
    const thirteen = UPGRADE_STATES.findLast(([, version]) => version.startsWith('13.'))?.[0]
    const old = await planImport({
      source: alteredCopy('thirteen', (db) =>
        db.run(
          `UPDATE umbracoKeyValue SET value = '{${thirteen?.toUpperCase()}}' WHERE "key" = 'Umbraco.Core.Upgrader.State+Umbraco.Core'`,
        ),
      ),
    })
    expect(old.report.umbraco.status).toBe('too-old')
    expect(old.report.ready).toBe(false)
    expect(old.files).toEqual([])
    const [blocking] = finding(old, 'version-too-old')
    expect(blocking?.class).toBe('blocking')
    expect(blocking?.detail).toContain(`Upgrade the site to Umbraco ${MINIMUM_MAJOR}`)
  })

  test('a database that is not Umbraco is refused rather than half-read', async () => {
    const path = join(work, 'other.sqlite')
    const db = new Database(path)
    db.run('CREATE TABLE orders (id INTEGER)')
    db.close()
    const other = await planImport({ source: path })
    expect(other.report.umbraco.status).toBe('unknown')
    expect(finding(other, 'not-umbraco')[0]?.class).toBe('blocking')
    expect(other.files).toEqual([])
  })

  test('a newer state than the table knows is attempted, and says so', async () => {
    const newer = await planImport({
      source: alteredCopy('newer', (db) =>
        db.run(
          `UPDATE umbracoKeyValue SET value = '{11111111-2222-3333-4444-555555555555}' WHERE "key" = 'Umbraco.Core.Upgrader.State+Umbraco.Core'`,
        ),
      ),
    })
    expect(newer.report.umbraco.status).toBe('newer')
    expect(finding(newer, 'version-newer')[0]?.class).toBe('needs-a-person')
    expect(newer.report.ready).toBe(true)
  })
})

describe('opening a backup', () => {
  test('a file that is neither kind says what is accepted', async () => {
    const path = join(work, 'backup.bak')
    writeFileSync(path, 'TAPE\0\0 not a bacpac')
    expect(planImport({ source: path })).rejects.toThrow('export a .bacpac')
    expect(planImport({ source: join(work, 'missing.bacpac') })).rejects.toThrow('No file at')
  })

  test('only the tables the importer reads are staged, and every table is still listed', async () => {
    const source = await openSource(DEMO_STORE)
    expect(source.kind).toBe('bacpac')
    expect(source.tables.length).toBe(127)
    expect(source.has('umbracoNode')).toBe(true)
    // A log table and a package's table: listed, not staged.
    expect(source.tables).toContain('umbracoLog')
    expect(source.has('umbracoLog')).toBe(false)
    expect(source.has('umbracoCommerceOrder')).toBe(false)
    expect(source.serverVersion).toStartWith('Microsoft SQL Server 2019')
    source.close()
  })

  test('a native SQLite backup, with its upper-case keys, converts to the same site', async () => {
    const native = await planImport({
      source: alteredCopy('native', (db) => {
        db.run(
          'UPDATE umbracoNode SET uniqueId = upper(uniqueId), nodeObjectType = upper(nodeObjectType)',
        )
        db.run('UPDATE cmsPropertyType SET UniqueID = upper(UniqueID)')
        db.run('UPDATE cmsContentType SET listView = upper(listView)')
        db.run('UPDATE cmsDictionary SET id = upper(id), parent = upper(parent)')
        db.run('UPDATE umbracoDocumentUrl SET uniqueId = upper(uniqueId)')
      }),
    })
    expect(native.report.source.kind).toBe('sqlite')
    const comparable = (p: ImportPlan) =>
      p.files
        .filter((f) => f.path.startsWith('schema/') || f.path.includes('/nodes/'))
        .map((f) => [f.path, f.text])
    expect(comparable(native)).toEqual(comparable(plan))
    expect(native.urls).toEqual(plan.urls)
  })
})

describe('the schema it writes', () => {
  test('loads back as valid schema files, with a view for every template', () => {
    const loaded = loadSchemaDirectory(join(site, 'schema'))
    expect(loaded.problems).toEqual([])
    expect(
      validateSchemaSet(loaded.set, { templateAliases: templateAliasesIn(join(site, 'Views')) }),
    ).toEqual([])
    expect(loaded.set.documentTypes.length).toBe(25)
    expect(loaded.set.languages.map((l) => [l.iso, l.default, l.fallback])).toEqual([
      ['en-US', true, undefined],
      ['nb', false, 'en-US'],
    ])
  })

  test('carries keys, folders, compositions, templates and collections', () => {
    const { set } = loadSchemaDirectory(join(site, 'schema'))
    const home = set.documentTypes.find((t) => t.alias === 'homePage')
    expect(home).toMatchObject({
      key: '4aafecde-1139-4823-a8ca-fcd293909ab1',
      name: 'Home Page',
      icon: 'icon-store color-black',
      allowAtRoot: true,
      folder: 'Pages',
      templates: ['HomePage'],
      defaultTemplate: 'HomePage',
    })
    expect(home?.compositions).toContain('pageComp')
    const products = set.documentTypes.find((t) => t.alias === 'productsPage')
    expect(products?.collection).toBe('listViewProductsPage')
    expect(set.documentTypes.find((t) => t.alias === 'pageComp')?.folder).toBe('Compositions')
  })

  test('keeps tabs and groups, and each property under the one it was in', () => {
    const { set } = loadSchemaDirectory(join(site, 'schema'))
    const page = set.documentTypes.find((t) => t.alias === 'pageComp')
    const groups = (page?.groups ?? []).map((g) => [g.alias, g.properties.map((p) => p.alias)])
    expect(groups.map(([alias]) => alias)).toEqual(['metaData', 'advanced'])
    expect(groups.flatMap(([, properties]) => properties).length).toBeGreaterThan(0)
  })

  test('an element type loses the route settings Umbraco let it keep', () => {
    const { set } = loadSchemaDirectory(join(site, 'schema'))
    for (const type of set.documentTypes.filter((t) => t.isElement)) {
      expect(type.templates).toEqual([])
      expect(type.allowAtRoot).toBe(false)
      expect(type.allowChildren).toEqual([])
    }
  })

  test('a built-in data type gets no file unless the site changed it', () => {
    const files = plan.files.filter((f) => f.path.startsWith('schema/data-types/'))
    const names = files.map((f) => f.path.split('/').at(-1))
    // 52 in the source; the unchanged built-ins need none.
    expect(files.length).toBe(25)
    expect(names).not.toContain('textstring.toml')
    expect(names).not.toContain('true-false.toml')
    // Changed from the default, so it is written under the built-in's alias.
    expect(fileText(plan, 'schema/data-types/richtext.toml')).toContain('alias = "richtext"')
    // A site's own data type is named from its name, with its key and editor kept.
    const price = fileText(plan, 'schema/data-types/umbraco-commerce-price.toml')
    expect(price).toContain('editor = "Umbraco.Commerce.Price"')
    expect(price).toContain('editor-ui = "Uc.PropertyEditorUi.Price"')
  })

  test('a rich text editor still set up for TinyMCE moves to Tiptap, and is reported', async () => {
    const tiny = await planImport({
      source: alteredCopy('tinymce', (db) =>
        db.run(
          "UPDATE umbracoDataType SET propertyEditorUiAlias = 'Umb.PropertyEditorUi.TinyMCE' WHERE propertyEditorAlias = 'Umbraco.RichText'",
        ),
      ),
    })
    expect(fileText(tiny, 'schema/data-types/richtext.toml')).toContain(
      'editor-ui = "Umb.PropertyEditorUi.Tiptap"',
    )
    expect(finding(tiny, 'tinymce-data-types')[0]).toMatchObject({
      class: 'needs-a-person',
      count: 2,
    })
    expect(finding(plan, 'tinymce-data-types')).toEqual([])
  })

  test('a value still in the column an older version used is found there', async () => {
    // Before 17, a checkbox list kept its value in the short text column.
    const moved = await planImport({
      source: alteredCopy('columns', (db) =>
        db.run(
          `UPDATE umbracoPropertyData SET varcharValue = textValue, textValue = NULL
           WHERE propertyTypeId IN (SELECT id FROM cmsPropertyType WHERE Alias = 'shortDescription')`,
        ),
      ),
    })
    const read = (p: ImportPlan) => storedValue(p, '15 tea bags', 'shortDescription')?.value
    expect(read(moved)).toBe(read(plan) as string)
    expect(read(plan)).toStartWith('15 tea bags')
  })

  test('a media type Umbraco ships is written only where the site changed it', () => {
    const written = plan.files
      .filter((f) => f.path.startsWith('schema/media-types/'))
      .map((f) => f.path.split('/').at(-1))
    // This site renamed Image's upload property and narrowed what a Folder allows.
    expect(written).toContain('image.toml')
    expect(fileText(plan, 'schema/media-types/folder.toml')).toContain(
      'allow-children = ["Folder", "Image", "File"]',
    )
    // Video, Audio, Article and SVG were left alone.
    expect(written).not.toContain('umbraco-media-video.toml')
  })
})

describe('the content it writes', () => {
  test('is a bundle `content import` reads, intact', () => {
    const loaded = loadBundle(join(site, 'bundles', 'umbraco-import'))
    expect(loaded.problems).toEqual([])
    expect(loaded.set?.manifest.counts).toEqual({ media: 255, document: 181 })
    expect(loaded.set?.manifest.snapshot).toBe('published')
    expect(loaded.set?.manifest.createdBy).toBe('bunbraco import umbraco')
    expect(loaded.set?.manifest.dependencies.expected).toEqual([])
  })

  test('carries the tree: parents by key, sort order, templates and published state', () => {
    const home = node(plan, 'Home')
    expect(home).toMatchObject({
      key: 'a8bcc42f-88a2-427d-8fcc-2de3ed457e57',
      kind: 'document',
      contentType: { key: '4aafecde-1139-4823-a8ca-fcd293909ab1', alias: 'homePage' },
      parent: null,
      template: 'HomePage',
      variants: [{ culture: null, segment: null, name: 'Home', published: true }],
    })
    const products = node(plan, 'Products')
    expect(products.parent).toBe(home.key)
    expect(products.template).toBe('ProductsPage')
  })

  test('hands each editor the value it expects', () => {
    const value = (name: string, property: string) => storedValue(plan, name, property)
    // A toggle is a boolean, not the 0 it was stored as.
    expect(value('Silver Needle', 'isGiftCard')).toMatchObject({
      editor: 'Umbraco.TrueFalse',
      value: false,
    })
    // Rich text is the markup-and-blocks object the editor takes.
    const credit = value('Nemi', 'imagesCredit')
    expect(credit?.editor).toBe('Umbraco.RichText')
    expect(Object.keys(credit?.value as object).sort()).toEqual(['blocks', 'markup'])
    expect(JSON.stringify(credit?.value)).toContain('<p>Images courtesy of')
    // A media item's file is the cropper's object, and its key is what the bundle lists.
    const white = node(plan, 'Whiterthanwhite', 'media')
    expect(white.kind).toBe('media')
    expect(white.variants[0]?.published).toBe(false)
    expect(white.values.find((v) => v.property === 'umbracoFile')?.value).toMatchObject({
      src: '/media/qvzdvqf4/whiterthanwhite.jpg',
    })
    // A third-party editor's value is carried exactly as it was stored.
    expect(value('125g', 'price')?.value).toBe(
      '{"9127e72b-be64-4f58-899a-018bff89d55e":5.95,"3e14c57c-a7f3-49c0-89cd-018bff8a7c12":6.7}',
    )
  })

  test('records the references a value holds, when the bundle carries their target', () => {
    const picker = node(plan, 'Checkout').values.find((v) => v.property === 'privacyPolicy')
    expect(picker?.value).toBe('umb://document/68cda2495e8047929564a9758a081921')
    expect(picker?.references).toEqual(['68cda249-5e80-4792-9564-a9758a081921'])
    expect(node(plan, 'Privacy Policy').key).toBe('68cda249-5e80-4792-9564-a9758a081921')
  })

  test('leaves the recycle bin behind, and says how much history went with it', () => {
    expect(finding(plan, 'recycle-bin')[0]).toMatchObject({ class: 'dropped', count: 1 })
    expect(finding(plan, 'version-history')[0]?.count).toBe(579)
    expect(finding(plan, 'content')[0]?.detail).toBe('181 documents, 255 media')
  })

  test('--drafts takes the working copy instead of what is published', async () => {
    const drafts = await planImport({ source: staging, drafts: true })
    const manifest = JSON.parse(fileText(drafts, 'bundles/umbraco-import/bundle.json') as string)
    expect(manifest.snapshot).toBe('drafts')
    expect(finding(drafts, 'pending-changes')).toEqual([])
  })

  test('lists the URLs the source site served', () => {
    // 181 pages are published; the 103 product variants have no template, so no URL.
    expect(plan.urls.length).toBe(78)
    expect(plan.urls.slice(0, 3)).toEqual(['/', '/categories', '/products'])
    expect(new Set(plan.urls).size).toBe(plan.urls.length)
    expect(fileText(plan, 'import/urls.txt')?.split('\n').length).toBe(79)
    expect(plan.urls.some((url) => url.endsWith('/125g'))).toBe(false)
  })
})

describe('the views it writes', () => {
  test('one stub per template, in the layout chain the Razor had', () => {
    const views = plan.files.filter((f) => f.path.startsWith('Views/'))
    expect(views.length).toBe(20)
    expect(fileText(plan, 'Views/HomePage.tsx')).toContain("export const layout = 'Page'")
    expect(fileText(plan, 'Views/Page.tsx')).toContain("export const layout = 'Layout'")
    // The outermost layout owns the document; the ones inside it only pass children on.
    expect(fileText(plan, 'Views/Layout.tsx')).toContain('<body>{children}</body>')
    expect(fileText(plan, 'Views/Layout.tsx')).not.toContain('export const layout')
    expect(fileText(plan, 'Views/Page.tsx')).toContain('<div>{children}</div>')
    // A template with no layout is a whole document on its own.
    expect(fileText(plan, 'Views/SitemapPage.tsx')).toContain('<html lang="en">')
  })

  test('every stub compiles', async () => {
    for (const file of plan.files.filter((f) => f.path.startsWith('Views/')))
      expect(() =>
        new Bun.Transpiler({ loader: 'tsx' }).transformSync(file.text as string),
      ).not.toThrow()
  })

  test('a component is named for its alias, whatever the alias holds', () => {
    expect(componentName('checkout-step_page')).toBe('CheckoutStepPage')
    expect(componentName('404')).toBe('View404')
    expect(
      viewStub({ id: 1, key: 'k', alias: 'my-page', name: 'My "Page"' }, { isLayout: false }),
    ).toContain('export default function MyPage({ model }: PageProps)')
  })
})

describe('the compatibility report', () => {
  test('names the package, and what goes with it', () => {
    const commerce = finding(plan, 'package').find((f) => f.title === 'Package: Umbraco Commerce')
    expect(commerce?.class).toBe('cannot-migrate')
    expect(commerce?.count).toBe(52)
    expect(commerce?.detail).toContain('Packages do not run here')
    expect(finding(plan, 'package-migrations')[0]?.items).toEqual(
      expect.arrayContaining(['Umbraco.Commerce', 'uSync_FirstBoot']),
    )
  })

  test('names each property editor with no equivalent, and the properties on it', () => {
    const editors = finding(plan, 'unsupported-editor')
    expect(editors.map((f) => f.title)).toEqual(
      expect.arrayContaining([
        'Property editor Umbraco.Commerce.Price has no equivalent here',
        'Property editor Umbraco.Commerce.VariantsEditor has no equivalent here',
      ]),
    )
    expect(editors.every((f) => f.class === 'needs-a-person')).toBe(true)
    expect(editors.find((f) => f.title.includes('Price'))?.items).toEqual(['productComp.price'])
  })

  test('says what a person has to do about templates, media and missing files', () => {
    expect(finding(plan, 'razor-templates')[0]).toMatchObject({
      class: 'needs-a-person',
      count: 20,
    })
    expect(finding(plan, 'media-files-missing')[0]?.count).toBe(193)
    expect(plan.missingMedia).toBe(193)
    expect(finding(plan, 'no-site-files')[0]?.class).toBe('needs-a-person')
  })

  test('is ready, and reads as a document', () => {
    expect(plan.report.ready).toBe(true)
    expect(plan.report.counts.blocking).toBe(0)
    const markdown = reportMarkdown(plan.report)
    expect(markdown).toStartWith('# Umbraco import report')
    expect(markdown).toContain('- **Umbraco version:** 17.0.0')
    expect(markdown).toContain('- **Verdict:** ready to import')
    expect(markdown.indexOf('## Needs a person')).toBeLessThan(markdown.indexOf('## Migrates'))
    expect(markdown).toContain('- … and ')
    expect(fileText(plan, 'import/report.md')).toContain('## Cannot be migrated')
    expect(JSON.parse(fileText(plan, 'import/report.json') as string).umbraco.version).toBe(
      '17.0.0',
    )
  })

  test('carries the dictionary, and counts what this version does not import', async () => {
    expect(plan.dictionary.map((item) => item.name)).toEqual(['Umbraco Commerce', 'Vendr'])
    expect(finding(plan, 'dictionary')[0]?.count).toBe(2)
    const withMembers = await planImport({
      source: alteredCopy('members', (db) => {
        db.run(
          "INSERT INTO cmsMember (nodeId, Email, LoginName, Password) VALUES (9001, 'a@example.com', 'a', 'x')",
        )
        db.run(
          "INSERT INTO umbracoDomain (domainDefaultLanguage, domainRootStructureID, domainName, sortOrder) VALUES (2, (SELECT id FROM umbracoNode WHERE uniqueId = 'a8bcc42f-88a2-427d-8fcc-2de3ed457e57'), 'shop.example.no', 0)",
        )
        db.run(
          "INSERT INTO umbracoDomain (domainDefaultLanguage, domainRootStructureID, domainName, sortOrder) VALUES (1, (SELECT id FROM umbracoNode WHERE uniqueId = 'a8bcc42f-88a2-427d-8fcc-2de3ed457e57'), '*1060', 1)",
        )
      }),
    })
    expect(finding(withMembers, 'members')[0]).toMatchObject({ class: 'not-yet', count: 1 })
    expect(withMembers.domains).toEqual([
      { node: 'a8bcc42f-88a2-427d-8fcc-2de3ed457e57', host: 'shop.example.no', culture: 'nb' },
      { node: 'a8bcc42f-88a2-427d-8fcc-2de3ed457e57', host: '', defaultCulture: 'en-US' },
    ])
  })
})

describe('with the site’s files', () => {
  test('finds the views, media, packages, plugins and code, wherever the web root is', async () => {
    const root = join(work, 'backup')
    const web = join(root, 'src', 'Store.Web')
    const put = (path: string, text: string) => {
      mkdirSync(join(web, path, '..'), { recursive: true })
      writeFileSync(join(web, path), text)
    }
    put(
      'Views/HomePage.cshtml',
      '@inherits UmbracoViewPage\n@{ Layout = "Page.cshtml"; }\n@await Html.PartialAsync("Hero")\n@inject IFoo Foo\n',
    )
    put('Views/Partials/Hero.cshtml', '<section>hero</section>\n')
    put('wwwroot/media/qvzdvqf4/whiterthanwhite.jpg', 'not really a jpeg')
    put('wwwroot/css/site.css', 'body { margin: 0 }')
    put('wwwroot/js/site.js', 'console.log(1)')
    put('App_Plugins/MyDashboard/umbraco-package.json', '{}')
    put('Controllers/CartController.cs', 'class CartController {}')
    put('bin/Debug/Ignored.cs', 'class Ignored {}')
    put(
      'Store.Web.csproj',
      '<Project><ItemGroup><PackageReference Include="Umbraco.Cms" Version="17.0.0" /><PackageReference Include="Umbraco.Commerce" Version="17.0.0" /><PackageReference Include="uSync" Version="17.0.0" /></ItemGroup></Project>',
    )

    const withSite = await planImport({ source: staging, site: root })
    expect(withSite.report.source.siteFiles).toBe(true)
    expect(finding(withSite, 'no-site-files')).toEqual([])

    // The original Razor is kept, and the stub says where.
    expect(
      withSite.files.find((f) => f.path === 'import/razor/Views/HomePage.cshtml')?.copyFrom,
    ).toBe(join(web, 'Views/HomePage.cshtml'))
    expect(fileText(withSite, 'Views/HomePage.tsx')).toContain(
      'The original is in import/razor/Views/HomePage.cshtml',
    )
    expect(finding(withSite, 'razor-templates')[0]?.items).toContain(
      'HomePage (5 lines, uses partials, injected services)',
    )
    expect(finding(withSite, 'razor-partials')[0]?.items).toEqual([
      'Views/Partials/Hero.cshtml (2 lines)',
    ])

    // The one media file present is copied under the key its value names.
    expect(
      withSite.files.find((f) => f.path === 'media/qvzdvqf4/whiterthanwhite.jpg')?.copyFrom,
    ).toBe(join(web, 'wwwroot/media/qvzdvqf4/whiterthanwhite.jpg'))
    expect(finding(withSite, 'media-files')[0]?.count).toBe(1)
    expect(withSite.missingMedia).toBe(192)

    expect(withSite.files.map((f) => f.path)).toEqual(
      expect.arrayContaining(['css/site.css', 'scripts/site.js']),
    )
    // Umbraco itself is not a package to report; what the site added is.
    expect(finding(withSite, 'nuget-packages')[0]?.items).toEqual([
      'Umbraco.Commerce 17.0.0',
      'uSync 17.0.0',
    ])
    expect(finding(withSite, 'app-plugins')[0]?.items).toEqual(['MyDashboard'])
    expect(finding(withSite, 'custom-code')[0]?.count).toBe(1)

    const elsewhere = join(work, 'media-elsewhere')
    mkdirSync(join(elsewhere, 'qvzdvqf4'), { recursive: true })
    writeFileSync(join(elsewhere, 'qvzdvqf4', 'whiterthanwhite.jpg'), 'x')
    const withMedia = await planImport({ source: staging, media: elsewhere })
    expect(withMedia.missingMedia).toBe(192)
  })
})

describe(`importing the result (${dialectUnderTest})`, () => {
  const open: Harness[] = []
  afterEach(async () => {
    while (open.length > 0)
      await open
        .pop()
        ?.db.close()
        .catch(() => {})
  })

  test('the schema syncs, the bundle imports whole, and the values read back', async () => {
    if (!(await canConnect())) throw new Error(`no ${dialectUnderTest} to test against`)
    expect(existsSync(join(site, 'schema', 'schema.toml'))).toBe(true)
    const h = await signedInServer({
      config: { schemaDir: join(site, 'schema'), viewsDir: join(site, 'Views') },
    })
    open.push(h)

    const { set, problems } = loadBundle(join(site, 'bundles', 'umbraco-import'))
    expect(problems).toEqual([])
    const result = await importBundle(h.server.db, set as never, {
      nodeId: 'test',
      publish: true,
      allowMissingBlobs: true,
      templateAliases: templateAliasesIn(join(site, 'Views')),
    })
    expect(result.check.outstanding).toEqual([])
    expect(result.runId).toBeDefined()
    expect(result.applied.filter((p) => p.action === 'create').length).toBe(436)
    expect(result.published.length).toBe(181)
    expect(result.publishFailures).toEqual([])

    const documents = new DocumentRepository(h.server.db, {
      nodeState: { version: '1.0.0', revision: '0' },
    })
    const home = await documents.byKey('a8bcc42f-88a2-427d-8fcc-2de3ed457e57')
    expect(home?.contentTypeAlias).toBe('homePage')
    expect(home?.values.find((v) => v.alias === 'siteName')?.value).toBe(
      node(plan, 'Home').values.find((v) => v.property === 'siteName')?.value,
    )
    const gift = await documents.byKey(node(plan, 'Silver Needle').key)
    expect(gift?.values.find((v) => v.alias === 'isGiftCard')?.value).toBe(false)
    // A value on an editor this system has no converter for comes back as it went in.
    const size = await documents.byKey(node(plan, '125g').key)
    expect(size?.values.find((v) => v.alias === 'price')?.value).toBe(
      node(plan, '125g').values.find((v) => v.property === 'price')?.value,
    )

    // Importing the same bundle again changes nothing.
    const again = await importBundle(h.server.db, set as never, {
      nodeId: 'test',
      allowMissingBlobs: true,
    })
    expect(again.applied.filter((p) => p.action !== 'unchanged')).toEqual([])
  }, 120_000)
})
