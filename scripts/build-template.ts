#!/usr/bin/env bun
/**
 * Regenerates a starter template's content bundle, and the demo's images.
 *
 *   bun run build:template                    every template
 *   bun run build:template demo/harbourstone  one of them
 *
 * The content is created through the repositories in a throwaway SQLite site
 * built from the template's own schema files, then exported through the same
 * path `bunbraco content export` uses. So the committed bundle is a real export:
 * its integrity hash comes from the shipping writer and every value is in the
 * shape the editors actually store. Node keys are fixed below, so regenerating
 * yields the same bundle rather than a diff full of new uuids.
 */
import { cpSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { findTemplate, listTemplates, type SiteTemplate } from '@bunbraco/cli'
import {
  ComponentRepository,
  ContentTypeRepository,
  currentSchemaState,
  type Db,
  DocumentRepository,
  type NodeRow,
} from '@bunbraco/data'
import {
  type BunbracoConfig,
  bootstrapDatabase,
  loadConfig,
  mediaStoreFor,
  readBlobs,
  syncSchemaDirectory,
} from '@bunbraco/server'
import { exportBundle, writeBundle } from '@bunbraco/transfer'

const ROOT = join(import.meta.dir, '..')

// The throwaway site is always a file, whatever the shell is pointed at.
delete process.env.BUNBRACO_DB
delete process.env.BUNBRACO_POSTGRES_URL

// --------------------------------------------------------------- the site

interface Site {
  db: Db
  config: BunbracoConfig
  template: SiteTemplate
  dir: string
  /** The keys to export, in the order they should be read. */
  roots: string[]
}

type Builder = (site: Site) => Promise<void>

async function throwawaySite(template: SiteTemplate): Promise<Site> {
  const dir = join(ROOT, 'output', 'template-build', template.id.replaceAll('/', '-'))
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  cpSync(join(template.dir, 'files'), dir, { recursive: true })
  const config = loadConfig(
    {
      siteName: template.name,
      dialect: 'sqlite',
      sqliteFile: join(dir, 'build.sqlite'),
      schemaDir: join(dir, 'schema'),
      componentsDir: join(dir, 'components'),
      mediaDir: join(dir, 'media'),
      development: true,
    },
    dir,
  )
  const { db } = await bootstrapDatabase(config)
  const report = await syncSchemaDirectory(db, config, {
    nodeId: config.nodeId,
    revision: config.schemaRevision,
  })
  if (report.action === 'refused')
    throw new Error(
      `${template.id}: schema refused — ${report.reason ?? report.problems.map((p) => `${p.file}: ${p.message}`).join('; ')}`,
    )
  return { db, config, template, dir, roots: [] }
}

/** Writers for one site, at the state the sync just put the database in. */
async function writers(site: Site) {
  const state = await currentSchemaState(site.db)
  const nodeState = { version: state.version, revision: state.revision }
  const options = { nodeState, nodeId: site.config.nodeId }
  const docs = new DocumentRepository(site.db, options)
  const elements = new DocumentRepository(site.db, { ...options, kind: 'element' })
  const media = new DocumentRepository(site.db, { ...options, kind: 'media' })
  const types = new ContentTypeRepository(site.db)
  const mediaTypes = new ContentTypeRepository(site.db, { kind: 'media' })
  const templates = new ComponentRepository(site.db)

  const typeKey = async (alias: string): Promise<string> => {
    const found = (await types.byAlias(alias)) ?? (await mediaTypes.byAlias(alias))
    if (!found?.key) throw new Error(`no content type "${alias}" in this template's schema`)
    return found.key
  }
  const componentKey = async (alias: string | undefined): Promise<string | null> => {
    if (!alias) return null
    const found = await templates.byAlias(alias)
    if (!found?.key) throw new Error(`no template "${alias}" — is components/${alias}.tsx there?`)
    return found.key
  }
  /**
   * The template a page gets when nothing names one: the type's own default.
   * Read from the type rather than assumed to be its alias, because a template
   * alias is now a path under `components/` and need not match the type.
   */
  const defaultTemplateOf = async (typeAlias: string): Promise<string | null> => {
    const found = await types.byAlias(typeAlias)
    return found?.defaultComponentKey ?? null
  }

  type Values = Record<string, unknown>
  const toValues = (values: Values) =>
    Object.entries(values)
      .filter(([, value]) => value !== undefined)
      .map(([alias, value]) => ({ alias, culture: null, segment: null, value }))

  /** A published page. `template` defaults to the type's own alias. */
  const page = async (input: {
    key: string
    type: string
    template?: string | null
    parent?: string
    name: string
    values: Values
  }): Promise<string> => {
    await docs.create({
      key: input.key,
      contentTypeKey: await typeKey(input.type),
      componentKey:
        input.template === null
          ? null
          : input.template
            ? await componentKey(input.template)
            : await defaultTemplateOf(input.type),
      parentKey: input.parent ?? null,
      values: toValues(input.values),
      variants: [{ culture: null, segment: null, name: input.name }],
    })
    await docs.publish(input.key, null)
    site.roots.push(input.key)
    return input.key
  }

  /** A published Library element. */
  const element = async (input: {
    key: string
    type: string
    name: string
    values: Values
  }): Promise<string> => {
    await elements.create({
      key: input.key,
      contentTypeKey: await typeKey(input.type),
      componentKey: null,
      parentKey: null,
      values: toValues(input.values),
      variants: [{ culture: null, segment: null, name: input.name }],
    })
    await elements.publish(input.key, null)
    site.roots.push(input.key)
    return input.key
  }

  /**
   * An image in the media library, with its bytes written under a key derived
   * from its own uuid — so the template's `media/` and the bundle agree, and a
   * rebuild does not move the files.
   *
   * The bytes are the file on disk, passed through untouched: re-encoding an
   * already-compressed JPEG on every build would churn the committed bundle and
   * lose a little more of the photograph each time. `assets/templates/` holds
   * the originals at the size they ship at, and is outside the `files` list in
   * `packages/cli/package.json`, so they are not published twice.
   */
  const image = async (input: { key: string; name: string; source: string }): Promise<string> => {
    const folder = input.key.replaceAll('-', '').slice(0, 8)
    const file = basename(input.source)
    const relative = `${folder}/${file}`
    const bytes = await Bun.file(input.source).bytes()
    const { width, height } = await new Bun.Image(bytes).metadata()
    // Only into the throwaway site's store: the bundle carries the bytes, so
    // the template ships them the way any other transfer would.
    mkdirSync(join(site.config.mediaDir, folder), { recursive: true })
    writeFileSync(join(site.config.mediaDir, relative), bytes)
    await media.create({
      key: input.key,
      contentTypeKey: await typeKey('Image'),
      componentKey: null,
      parentKey: null,
      values: toValues({
        umbracoFile: { src: `/media/${relative}`, crops: [], focalPoint: null },
        umbracoWidth: width,
        umbracoHeight: height,
        umbracoBytes: bytes.length,
        umbracoExtension: 'jpg',
      }),
      variants: [{ culture: null, segment: null, name: input.name }],
    })
    site.roots.push(input.key)
    return input.key
  }

  return { page, element, image }
}

/**
 * What an image picker stores: a pick per media node.
 *
 * The pick's own key is derived from the media key rather than random, so a
 * rebuild yields the same bundle — the determinism the node keys above are
 * fixed for. A random one per build churned every picker on every rebuild,
 * which buried the change being made in a diff of fresh uuids.
 */
const pick = (mediaKey: string) => [
  { key: pickKey(mediaKey), mediaKey, mediaTypeAlias: 'Image', crops: [], focalPoint: null },
]

/** A uuid-shaped digest of the media key: stable, and distinct from it. */
function pickKey(mediaKey: string): string {
  const hex = new Bun.CryptoHasher('sha256').update(`pick:${mediaKey}`).digest('hex')
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    `4${hex.slice(13, 16)}`,
    `8${hex.slice(17, 20)}`,
    hex.slice(20, 32),
  ].join('-')
}

/** What the rich-text editor stores. */
const richtext = (markup: string) => ({ markup, blocks: null })

// ------------------------------------------------------------- the content

const BASIC: Builder = async (site) => {
  const { page } = await writers(site)
  await page({
    key: '36955f6e-d110-469e-b280-72096eccd148',
    type: 'homePage',
    name: 'Home',
    values: {
      title: 'A new bunbraco site',
      bodyText: richtext(
        '<p>This page is content: it lives in the database and you edit it in the backoffice. ' +
          'Its <em>shape</em> is code — <code>schema/content-types/home-page.toml</code> — and the ' +
          'markup around it is <code>components/homePage.tsx</code>.</p>' +
          '<p>Add a property to the TOML, run <code>bunbraco schema check</code> to see what it would ' +
          'do to this page, then <code>bunbraco start</code> to apply it.</p>',
      ),
    },
  })
}

/** The photographs this template ships, at the size they ship at. */
const PHOTOS = join(ROOT, 'assets/templates/harbourstone')

const HARBOURSTONE: Builder = async (site) => {
  const { page, element, image } = await writers(site)

  const cliff = await image({
    key: '180cc8ef-caf1-4316-b6a7-e3b5aee41ffd',
    name: 'Harbourstone above Stenwick cove',
    source: join(PHOTOS, 'distillery-from-the-cliff-path.jpg'),
  })
  const stills = await image({
    key: '7b4713f8-d917-457d-a9d8-7dd01a3617b4',
    name: 'Copper pot stills in the stillhouse',
    source: join(PHOTOS, 'copper-pot-stills.jpg'),
  })
  const warehouse = await image({
    key: 'fd337567-df67-41ca-ae94-9d84d8d6042f',
    name: 'Casks in the sea-facing warehouse',
    source: join(PHOTOS, 'casks-in-the-sea-facing-warehouse.jpg'),
  })
  const coveBottle = await image({
    key: '6d8d6398-738f-4f38-ad3c-e5d6e9a971fe',
    name: 'The Cove',
    source: join(PHOTOS, 'bottle-the-cove.jpg'),
  })
  const brineBottle = await image({
    key: '68c9cfdf-6b40-47da-a1d2-17256a6cc6db',
    name: 'Brine & Kiln',
    source: join(PHOTOS, 'bottle-brine-and-kiln.jpg'),
  })
  const pierBottle = await image({
    key: '6be45535-83e5-4469-acf0-4127016721ae',
    name: 'Oloroso Pier',
    source: join(PHOTOS, 'bottle-oloroso-pier.jpg'),
  })
  const neapBottle = await image({
    key: 'c114b7d8-0138-404b-9d8f-a39d992577a2',
    name: 'Neap Tide',
    source: join(PHOTOS, 'bottle-neap-tide.jpg'),
  })

  const note = (key: string, aspect: string, text: string) =>
    element({
      key,
      type: 'tastingNote',
      name: `${aspect} — ${text.slice(0, 28)}…`,
      values: { aspect, note: text },
    })

  /** The same element type on both pages: a short heading and a line under it. */
  const highlight = (key: string, heading: string, detail: string) =>
    element({ key, type: 'highlight', name: heading, values: { heading, detail } })

  const figures = [
    await highlight('3dc30fc1-973a-4217-b26f-24902210be17', '1894', 'First season on this rock'),
    await highlight('d7f13222-d060-4496-b86d-bef21da963c1', '2', 'Pot stills, wash and spirit'),
    await highlight('a5e36a18-a2ef-4eb5-85b4-7e12b21cca06', '46%', 'Core range, bottled here'),
    await highlight('4e5c7f3f-54cb-4328-ad61-bc4c2736b890', '12–21', 'Years in the current make'),
  ]
  const decisions = [
    await highlight(
      '62f479ff-0875-453e-99ae-3bf1bec5e3c8',
      'Water',
      'Hill spring above the cove, soft and cold.',
    ),
    await highlight(
      '38b009f7-03c0-4fda-b5c7-843ad6044e9c',
      'Malt',
      'Concerto barley, with a little local peat.',
    ),
    await highlight(
      '069cc3c5-c9f5-4792-90c9-e2bfcc4855b6',
      'Copper',
      'One wash still, one tall spirit still.',
    ),
    await highlight(
      '13788fe7-1a45-4b48-8ae4-f4227e154e1e',
      'Wood',
      'Bourbon hogsheads, refill, and sherry butts.',
    ),
  ]

  const coveNotes = [
    await note(
      '483a0d3b-a10c-4c9d-8c81-d9607d37e968',
      'Nose',
      'Lemon zest, warm porridge, wet slate, a thread of vanilla.',
    ),
    await note(
      '88ec1185-53b5-439a-a2ce-3f56603be4ff',
      'Palate',
      'Malt biscuit, green apple, sea spray, white pepper.',
    ),
    await note(
      'b4e38bbd-c1a3-431a-b7a9-5868aa32993a',
      'Finish',
      'Clean and saline, with oak spice that stays polite.',
    ),
  ]
  const brineNotes = [
    await note(
      '22144db2-e214-4006-a0bb-53b5bd121fd6',
      'Nose',
      'Cold kiln smoke, kelp, lemon oil, crushed shells.',
    ),
    await note(
      '4b760c0b-b83a-4eee-aa29-c225cfabf19b',
      'Palate',
      'Sweet peat, oyster shell, black pepper, barley sugar.',
    ),
    await note(
      '97469df2-107c-4010-8c14-4de88f735529',
      'Finish',
      'Iodine and ember. Long, but never heavy.',
    ),
  ]
  const pierNotes = [
    await note(
      'b1876d3a-50a7-4358-84bf-a0899932ffa9',
      'Nose',
      'Fig, orange marmalade, walnut, a lift of sea air.',
    ),
    await note(
      '2fe03891-1294-4344-8e24-47e8b212e5b0',
      'Palate',
      'Dark honey, cocoa nib, salted caramel, polished oak.',
    ),
    await note(
      'f36dd4a9-927c-4ca3-a790-c9c859ac7302',
      'Finish',
      'Dry and long. Tannin held in check by brine.',
    ),
  ]
  const neapNotes = [
    await note(
      '2caa099b-3884-472d-9cea-797a0f0c376f',
      'Nose',
      'Heather honey, warm oak, candle wax, coastal air.',
    ),
    await note(
      '26e87610-e2d6-4b47-bf92-3967f7186907',
      'Palate',
      'Thick barley, white pepper, brine, toasted hazelnut.',
    ),
    await note(
      'a2eb439f-71d9-4ea6-89d7-c5bc72618281',
      'Finish',
      'Powerful and warming. Water opens a bright citrus edge.',
    ),
  ]

  const home = await page({
    key: 'd60ef12b-0f0a-4db5-9763-21fa52b8d4da',
    type: 'homePage',
    name: 'Harbourstone',
    values: {
      eyebrow: 'Caithness · North coast of Scotland',
      title: 'Harbourstone',
      strapline:
        'A cliff-side distillery where Atlantic weather, pale malt, and warehouse salt shape a coastal single malt.',
      heroImage: pick(cliff),
      heroCtaLabel: 'The bottlings',
      styleEyebrow: 'The house style',
      styleHeading: 'Salt on the rim of the glass.',
      styleIntro: richtext(
        '<p>Spring water comes off the peat-dark hills behind the stillhouse. Spirit is filled into ' +
          'casks that sleep in stone warehouses open to the sea wind. We do not chill-filter, and we ' +
          'do not colour.</p>',
      ),
      stats: figures,
      styleImage: pick(stills),
      rangeEyebrow: 'On offer',
      rangeHeading: 'Four expressions, one shoreline.',
      rangeCtaLabel: 'Tasting notes',
    },
  })

  await page({
    key: 'cb4c569e-c28a-43b6-a4d7-d33bb544e973',
    type: 'contentPage',
    parent: home,
    name: 'About',
    values: {
      eyebrow: 'The distillery',
      title: 'Built for weather, not for show.',
      standfirst:
        'Harbourstone was raised in 1894 by the MacLeod shipping family, who wanted a malt that ' +
        'tasted of the coast their herring boats worked. The stillhouse has never moved from the ' +
        'shelf of rock above Stenwick cove.',
      heroImage: pick(cliff),
      sectionEyebrow: 'Place',
      sectionHeading: 'A working shore, not a postcard.',
      bodyText: richtext(
        '<p>Barley is malted to order, a portion of it dried over coastal peat cut behind Dunnet. ' +
          'Fermentation runs long — usually eighty hours — so the wash arrives at the stills bright ' +
          'and estery. The spirit still is narrow-necked, and the cut is kept tight.</p>' +
          '<p>Warehouses 1 and 2 stand on the old boat green. Casks are racked three high so the sea ' +
          'air can move between them.</p>',
      ),
      highlightsEyebrow: 'How it is made',
      highlightsHeading: 'Four decisions that set the style.',
      highlights: decisions,
      highlightsImage: pick(warehouse),
    },
  })

  const range = await page({
    key: '2efbdb5b-7888-4a49-bca5-c0f85b76e472',
    type: 'whiskyList',
    parent: home,
    name: 'Bottlings',
    values: {
      eyebrow: 'The range',
      title: 'Bottlings on offer.',
      standfirst:
        'All Harbourstone single malt is bottled at the distillery. Natural colour. Non-chill ' +
        'filtered. 700 ml.',
    },
  })

  await page({
    key: '6ad8f0f3-9334-47f1-b805-80c4b4b4fa88',
    type: 'expression',
    parent: range,
    name: 'The Cove',
    values: {
      title: 'The Cove',
      kind: 'House malt',
      abv: '46%',
      age: 12,
      summary: 'Ex-bourbon and refill hogsheads. The everyday dram from the shore.',
      bottleImage: pick(coveBottle),
      bodyText: richtext(
        '<p>The house style with nothing in the way of it: twelve years in ex-bourbon and refill ' +
          'hogsheads in the low warehouse nearest the water, and no attempt to make it into ' +
          'anything else.</p>',
      ),
      tastingNotes: coveNotes,
    },
  })
  await page({
    key: 'a562f0a2-cb6e-4ead-a1ce-4d180632419f',
    type: 'expression',
    parent: range,
    name: 'Brine and Kiln',
    values: {
      title: 'Brine & Kiln',
      kind: 'Lightly peated',
      abv: '46%',
      age: 14,
      summary: 'Coastal peat at 18 ppm. Smoke that tastes of weather, not a bonfire.',
      bottleImage: pick(brineBottle),
      bodyText: richtext(
        '<p>A portion of the malt dried over peat cut behind Dunnet, which is wet, salty ground and ' +
          'gives a smoke quite unlike an inland one. Fourteen years, and the smoke has had time to ' +
          'settle under the fruit rather than sit on top of it.</p>',
      ),
      tastingNotes: brineNotes,
    },
  })
  await page({
    key: 'cd681b4b-9c4e-4624-9c13-450aa6a9c135',
    type: 'expression',
    parent: range,
    name: 'Oloroso Pier',
    values: {
      title: 'Oloroso Pier',
      kind: 'Sherry matured',
      abv: '46%',
      age: 18,
      summary: 'First-fill oloroso butts. 1,800 bottles from the boat-green warehouses.',
      bottleImage: pick(pierBottle),
      bodyText: richtext(
        '<p>Eighteen years in first-fill oloroso butts racked on the boat green, where the air is ' +
          'wettest. Sherry wood can bury a coastal spirit; this one is still recognisably ours, ' +
          'which is why there are only 1,800 bottles of it.</p>',
      ),
      tastingNotes: pierNotes,
    },
  })
  await page({
    key: '40107d59-f3e9-4592-aee8-5b03d4586cbd',
    type: 'expression',
    parent: range,
    name: 'Neap Tide',
    values: {
      title: 'Neap Tide',
      kind: 'Cask strength',
      abv: '58.4%',
      batch: '07',
      summary: 'Unreduced vatting of first-fill bourbon. Add water when you are ready.',
      bottleImage: pick(neapBottle),
      bodyText: richtext(
        '<p>No age statement and no reduction: a small vatting of first-fill bourbon barrels taken ' +
          'at the strength they came out at. Batch 07 is 58.4%. Water is not cheating.</p>',
      ),
      tastingNotes: neapNotes,
    },
  })

  await page({
    key: '3d312cc8-2937-40e1-ba14-fd781c9a862d',
    type: 'contactPage',
    parent: home,
    name: 'Contact',
    values: {
      eyebrow: 'Visitors and trade',
      title: 'Write to the cove.',
      standfirst:
        'Tours run Thursday to Saturday, April through October, and only by appointment. The road ' +
        'down to Stenwick is single-track.',
      // A `formPicker` stores the form's UUID, which is the `key` in
      // `files/schema/forms/contact.toml`. Written here rather than left for
      // someone to pick in the backoffice, so the demo arrives with a working
      // form on the page.
      enquiryForm: '7b1f4c20-9a63-4e18-8d25-3c6f5a1e9b04',
      asideEyebrow: 'Distillery',
      asideHeading: 'Cove of Stenwick, Caithness',
      asideBody: richtext(
        '<p>Harbourstone Distillery<br />Stenwick Shore Road<br />Near Dunnet Head<br />' +
          'North coast, Scotland</p>' +
          '<p>visitors@harbourstone.scot<br />+44 (0)1847 555 014</p>',
      ),
      asideImage: pick(warehouse),
    },
  })
}

/** The sample on the developer page, as it would sit in `components/pages/`. */
const TSX_SAMPLE = `import type { PageProps } from 'bunbraco'
import { Layout } from '../shared/layout.tsx'

export default function Article({ model, nav }: PageProps) {
  return (
    <Layout model={model} nav={nav}>
      <h1>{model.text('title')}</h1>
      {model.html('bodyText')}
    </Layout>
  )
}`

const BUNBRACO: Builder = async (site) => {
  const { page, element } = await writers(site)

  const feature = (key: string, heading: string, detail: string) =>
    element({ key, type: 'feature', name: heading, values: { heading, detail } })
  const step = (key: string, heading: string, detail: string, command?: string) =>
    element({ key, type: 'step', name: heading, values: { heading, detail, command } })

  const reasons = [
    await feature(
      'b13339a3-69dd-43a2-a766-9ed92c8e7a28',
      'No retraining',
      'Editors work in the back office they already know from Umbraco. The content tree, drafts, scheduling, version history and media library are all where they expect them.',
    ),
    await feature(
      '7a0bca8c-36cf-4602-b204-1b6674d2e1ee',
      'Lower running costs',
      'One lightweight process on SQLite or Postgres, hosted on modest Linux infrastructure. No licence fees, and no paid add-ons for essentials like forms.',
    ),
    await feature(
      'e41ed7cc-3023-43a1-93ad-83f1b2ea1559',
      'Fast by default',
      'Pages are plain HTML rendered on the server, with no client-side framework to download, so sites load quickly and score well on Core Web Vitals.',
    ),
    await feature(
      '1b966f5b-2fa6-4912-92aa-6390e00ac12e',
      'Yours to own',
      'Open source from end to end. Host it wherever you like, keep your content in a standard database, and never depend on a single vendor.',
    ),
  ]

  const editorFeatures = [
    await feature(
      '5846d97d-b99b-4949-951d-43eda14b73ee',
      'Drafts, scheduling and version history',
      'Prepare changes in draft, publish on a schedule, and roll back to any earlier version.',
    ),
    await feature(
      '4d577630-7c9f-46c0-a0d5-f887daef0aa0',
      'A media library with cropping',
      'Upload an image once and crop it for every place it appears.',
    ),
    await feature(
      '9ccf8f41-fdb9-4a17-87d2-69835c42d5bd',
      'Flexible page layouts',
      'Build pages from blocks your developers design, arranged as lists or grids.',
    ),
    await feature(
      '9249bc6e-4bb3-4161-a538-a7c8008f1c95',
      'Forms built in',
      'Design forms in the back office and review every submission in one place.',
    ),
    await feature(
      '28e248bf-609b-4a0e-a2fa-1c2a8cc6846f',
      'Redirects you manage yourself',
      'When a page moves, its old address follows it. Add your own redirects without raising a ticket.',
    ),
    await feature(
      '6a683488-cad5-4765-b253-044090a86505',
      'An AI assistant that asks first',
      'Optional help building pages and content. It proposes changes for you to review, and it can never publish.',
    ),
    await feature(
      'f6c036de-300b-42d5-aa83-56f60fa26ef2',
      'Upgrades that keep the site live',
      'Visitors keep seeing your site while a new version rolls out.',
    ),
  ]

  const toolkit = [
    await feature(
      '566477d3-97a4-446b-b9f1-d9b0f810caa8',
      'Your content model in Git',
      'Document types are readable TOML files you can diff and review, and bunbraco generate turns them into TypeScript types.',
    ),
    await feature(
      '6bd08968-76a1-4f96-a7bf-453bad090fdc',
      'One runtime',
      'Bun runs the server, the build and the tests. No Node toolchain and no .NET SDK.',
    ),
    await feature(
      'fe380729-34ae-48f6-848c-ab6e20d20b09',
      'SQLite or Postgres',
      'Start on SQLite with nothing to configure, and move to Postgres when you need to.',
    ),
    await feature(
      'eda4ab14-74bf-446d-bb3e-064be4e5913b',
      'Checks before production',
      'bunbraco components check compiles every template in CI, so a broken page is caught before a visitor sees it.',
    ),
    await feature(
      'ad985566-f642-413e-83e5-3e9bb4cdf283',
      'Upgrades you can rehearse',
      'Check an upgrade before you run it, then roll it out while the old version keeps serving pages.',
    ),
    await feature(
      '9fbf656c-7b94-4f38-9c45-b4a93dea980d',
      'Content between environments',
      'Export content as a bundle of files you can review, then import it into staging or production.',
    ),
    await feature(
      '704573e6-9386-4273-b6e8-04110bf6a9eb',
      'Reusable bundles',
      'Package schema, templates, content and media together, and install them into another site or publish them to npm.',
    ),
  ]

  const steps = [
    await step(
      '03ef280b-511e-4778-859b-34e6a48be6f6',
      'Install Bun',
      'Bunbraco runs on Bun 1.3 or later. A SQLite site needs nothing else.',
      'curl -fsSL https://bun.sh/install | bash',
    ),
    await step(
      '6fbd32fd-64ea-4cc1-867d-a453a3fc6d7a',
      'Create a site',
      'Scaffold a site in an empty folder. Add --template list to see the starter sites, or --postgres to use Postgres.',
      'mkdir my-site && cd my-site\nbunx bunbraco init --name "My Site"',
    ),
    await step(
      'c7d11c0f-afa9-4269-9f26-c52e8cb09b0e',
      'Install and start',
      'The first start creates the database, then prints the back office address and your sign-in details.',
      'bun install\nbun start',
    ),
    await step(
      '05b6bdcb-2635-4a84-96e3-aa51980f368a',
      'Model your content',
      'Sign in at http://localhost:8080/bunbraco and create your document types. Each one is saved as a TOML file under schema/, ready to commit.',
    ),
    await step(
      'a90cf801-2632-4000-85e6-14056ccacbb4',
      'Write a template',
      'Add a component under components/, or create one from the back office. Generate types for your document types to get autocomplete as you write.',
      'bunx bunbraco components new pages/article\nbunx bunbraco generate',
    ),
    await step(
      '276110ee-fb7c-4e1b-8648-89b8f828e161',
      'Check before you ship',
      'Compile every template in CI, so a broken page never reaches a visitor.',
      'bunx bunbraco components check',
    ),
  ]

  const home = await page({
    key: '1f9d8eb5-4a8d-448d-bedc-a84f33ddab21',
    type: 'homePage',
    name: 'Home',
    values: {
      title: 'The CMS your editors already know',
      strapline:
        'Bunbraco gives your content team the Umbraco editing experience they trust, on an open-source platform that is quicker to build on and cheaper to run.',
      heroCtaLabel: 'Get started',
      whyHeading: 'Why teams switch to Bunbraco',
      whyIntro:
        'Keep the editing experience your team relies on, without the platform costs and constraints that usually come with it.',
      reasons,
      editorsHeading: 'Built for the people who publish',
      editorsIntro:
        'Familiar from the first login, with the tools content teams ask for already included.',
      editorFeatures,
      migrateHeading: 'Already on Umbraco?',
      migrateBody: richtext(
        '<p>The import tool starts with a compatibility report, so you know exactly what will ' +
          'move across before anything changes. It then brings your content types, content and ' +
          'media into a new Bunbraco site.</p>' +
          '<p>Your editors keep working in a back office they already trust.</p>',
      ),
      developersHeading: 'Your developers will thank you',
      developersIntro:
        'TypeScript templates, a content model kept in Git, and a single runtime that starts in seconds. No .NET, no Razor.',
      developersCtaLabel: 'Read the developer guide',
      closingHeading: 'Up and running in minutes',
      closingBody:
        'One command creates a site, and the developer guide takes you from there to your first published page.',
      repositoryUrl: 'https://github.com/kineco-au/bunbraco-cms',
      installCommand: 'bunx bunbraco init',
    },
  })

  await page({
    key: 'fa2dd680-27ba-4811-8dc2-101cb3813c6d',
    type: 'developerPage',
    parent: home,
    name: 'Developers',
    values: {
      eyebrow: 'For developers',
      title: 'Templates in TSX, schema in Git, one runtime',
      standfirst:
        'Bunbraco keeps the back office your editors know and rebuilds everything behind it in TypeScript on Bun. Here is what that means for you, and how to get started.',
      codeHeading: 'Templates are typed components',
      codeIntro:
        'Write pages as React-style TSX components. They render to HTML on the server, with no React runtime and no hydration, and your changes show up without a restart.',
      codeSample: TSX_SAMPLE,
      toolkitHeading: 'What you get',
      toolkit,
      stepsHeading: 'Get started',
      steps,
      nextSteps: richtext(
        '<p>The README covers configuration, deployment, importing from Umbraco and the rest ' +
          'of the toolkit in depth.</p>',
      ),
    },
  })
}

const BUILDERS: Record<string, Builder> = {
  basic: BASIC,
  'demo/bunbraco': BUNBRACO,
  'demo/harbourstone': HARBOURSTONE,
}

/**
 * A template's bundle id is fixed, not generated: `start --bundle` imports once
 * per id, so a rebuild must not look like a different bundle to a site that
 * already has this content.
 */
const BUNDLE_IDS: Record<string, string> = {
  basic: '2de473a2-d391-4161-801e-e34b202759b8',
  'demo/bunbraco': 'ffc7145b-99fa-48da-9daf-12cd61454a22',
  'demo/harbourstone': 'af030aee-ba70-4bed-8a27-a3806a79100d',
}

/**
 * The provenance of a committed artifact is the release it ships in, not the
 * machine and minute it was built on — which would otherwise put a developer's
 * hostname in the published package and churn the diff on every rebuild.
 */
const PROVENANCE = { createdBy: 'bun run build:template', createdAt: '2026-10-01T00:00:00.000Z' }

// ------------------------------------------------------------------- main

async function build(template: SiteTemplate): Promise<void> {
  const builder = BUILDERS[template.id]
  if (!builder) throw new Error(`no content builder for "${template.id}" in ${import.meta.file}`)

  rmSync(join(template.dir, 'bundle'), { recursive: true, force: true })

  const site = await throwawaySite(template)
  try {
    await builder(site)

    // Every node is named as a root: the exporter takes the selection and its
    // descendants, and does not follow references, so the media and the
    // elements the pages point at have to be asked for by name.
    const nodes = new DocumentRepository(site.db).nodes
    const roots: NodeRow[] = []
    for (const key of site.roots) {
      const row = await nodes.byKey(key)
      if (!row) throw new Error(`created ${key} but cannot read it back`)
      roots.push(row)
    }

    const { set, blobKeys } = await exportBundle(site.db, {
      roots,
      asGiven: [template.id],
      descendants: true,
      snapshot: 'published',
      blueprints: false,
      // The bundle carries the bytes, so `start --bundle` places them in
      // whatever store the new site has — a disk, a bucket, a container.
      withBlobs: true,
      siteName: template.name,
      nodeId: site.config.nodeId,
    })
    const id = BUNDLE_IDS[template.id]
    if (!id) throw new Error(`no fixed bundle id for "${template.id}"`)
    const stable = {
      ...set,
      manifest: {
        ...set.manifest,
        id,
        createdBy: PROVENANCE.createdBy,
        createdAt: PROVENANCE.createdAt,
      },
    }
    const store = await mediaStoreFor(site.config)
    const read = await readBlobs(store, blobKeys)
    if (read.missing.length > 0)
      throw new Error(`built media that is not in the store: ${read.missing.join(', ')}`)

    for (const file of writeBundle(stable, read.bytes)) {
      const target = join(template.dir, 'bundle', file.path)
      mkdirSync(join(target, '..'), { recursive: true })
      writeFileSync(target, file.bytes ?? (file.text as string))
    }
    const counts = Object.entries(set.manifest.counts)
      .map(([kind, n]) => `${n} ${kind}`)
      .join(', ')
    console.log(`  ${template.id.padEnd(20)} ${counts}`)
  } finally {
    await site.db.close()
  }
}

const requested = Bun.argv.slice(2).filter((arg) => !arg.startsWith('--'))
const templates =
  requested.length > 0
    ? requested.map((id) => {
        const found = findTemplate(id)
        if (!found) throw new Error(`no template "${id}"`)
        return found
      })
    : listTemplates()

for (const template of templates) await build(template)
