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
import { join } from 'node:path'
import { findTemplate, listTemplates, type SiteTemplate } from '@bunbraco/cli'
import {
  ContentTypeRepository,
  currentSchemaState,
  type Db,
  DocumentRepository,
  type NodeRow,
  TemplateRepository,
} from '@bunbraco/data'
import {
  type BunbracoConfig,
  bootstrapDatabase,
  encodePng,
  loadConfig,
  mediaStoreFor,
  type Pixels,
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
      viewsDir: join(dir, 'Views'),
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
  const templates = new TemplateRepository(site.db)

  const typeKey = async (alias: string): Promise<string> => {
    const found = (await types.byAlias(alias)) ?? (await mediaTypes.byAlias(alias))
    if (!found?.key) throw new Error(`no content type "${alias}" in this template's schema`)
    return found.key
  }
  const templateKey = async (alias: string | undefined): Promise<string | null> => {
    if (!alias) return null
    const found = await templates.byAlias(alias)
    if (!found?.key) throw new Error(`no template "${alias}" — is Views/${alias}.tsx there?`)
    return found.key
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
      templateKey: await templateKey(
        input.template === null ? undefined : (input.template ?? input.type),
      ),
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
      templateKey: null,
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
   */
  const image = async (input: {
    key: string
    name: string
    file: string
    pixels: Pixels
  }): Promise<string> => {
    const folder = input.key.replaceAll('-', '').slice(0, 8)
    const relative = `${folder}/${input.file}`
    const jpeg = await new Bun.Image(encodePng(input.pixels)).jpeg({ quality: 82 }).bytes()
    // Only into the throwaway site's store: the bundle carries the bytes, so
    // the template ships them the way any other transfer would.
    mkdirSync(join(site.config.mediaDir, folder), { recursive: true })
    writeFileSync(join(site.config.mediaDir, relative), jpeg)
    await media.create({
      key: input.key,
      contentTypeKey: await typeKey('Image'),
      templateKey: null,
      parentKey: null,
      values: toValues({
        umbracoFile: { src: `/media/${relative}`, crops: [], focalPoint: null },
        umbracoWidth: input.pixels.width,
        umbracoHeight: input.pixels.height,
        umbracoBytes: jpeg.length,
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

// -------------------------------------------------------------- the images

/**
 * Sea, stone and sky: a deterministic placeholder, so the demo ships images
 * without the repo acquiring photographs. Bands and a low sun, dithered a
 * little so the JPEG does not band visibly.
 */
function coastline(width: number, height: number, seed: number): Pixels {
  const data = new Uint8Array(width * height * 4)
  let state = seed
  const noise = (): number => {
    state = (state * 1664525 + 1013904223) >>> 0
    return state / 0xffffffff
  }
  const horizon = Math.round(height * 0.62)
  const sun = { x: width * (0.3 + (0.4 * (seed % 7)) / 7), y: horizon * 0.55, r: height * 0.14 }
  const mix = (a: number, b: number, t: number) => a + (b - a) * t
  for (let y = 0; y < height; y++) {
    const sky = y / horizon
    for (let x = 0; x < width; x++) {
      let r: number
      let g: number
      let b: number
      if (y < horizon) {
        r = mix(214, 142, sky)
        g = mix(221, 170, sky)
        b = mix(223, 176, sky)
        const dx = x - sun.x
        const dy = y - sun.y
        const glow = Math.max(0, 1 - Math.hypot(dx, dy) / (sun.r * 2.6))
        r = mix(r, 246, glow * 0.8)
        g = mix(g, 228, glow * 0.8)
        b = mix(b, 196, glow * 0.6)
      } else {
        const depth = (y - horizon) / Math.max(1, height - horizon)
        r = mix(58, 24, depth)
        g = mix(94, 50, depth)
        b = mix(108, 64, depth)
        // A few flat swells, lighter where the sun is.
        const swell = Math.sin(x / (width / 18) + depth * 6 + seed) * 0.5 + 0.5
        const lit = Math.max(0, 1 - Math.abs(x - sun.x) / (width * 0.45))
        const sheen = swell * 0.14 * (0.3 + lit)
        r = mix(r, 226, sheen)
        g = mix(g, 232, sheen)
        b = mix(b, 220, sheen)
      }
      // The stone band: a dark headland along the horizon.
      if (y >= horizon - height * 0.06 && y < horizon) {
        const ridge =
          horizon - height * (0.02 + 0.035 * (Math.sin(x / (width / 9) + seed) * 0.5 + 0.5))
        if (y > ridge) {
          r = 46
          g = 52
          b = 54
        }
      }
      const grain = (noise() - 0.5) * 6
      const i = (y * width + x) * 4
      data[i] = Math.max(0, Math.min(255, Math.round(r + grain)))
      data[i + 1] = Math.max(0, Math.min(255, Math.round(g + grain)))
      data[i + 2] = Math.max(0, Math.min(255, Math.round(b + grain)))
      data[i + 3] = 255
    }
  }
  return { width, height, data }
}

/** A bottle on a plain ground: enough to read as a product shot at any crop. */
function bottle(size: number, seed: number, glass: [number, number, number]): Pixels {
  const data = new Uint8Array(size * size * 4)
  let state = seed
  const noise = (): number => {
    state = (state * 1103515245 + 12345) >>> 0
    return state / 0xffffffff
  }
  const capTop = size * 0.08
  const capBottom = size * 0.17
  const shoulderTop = size * 0.32
  const shoulderBottom = size * 0.46
  const bottom = size * 0.93
  const neckHalf = size * 0.052
  const bodyHalf = size * 0.185
  const label = { top: size * 0.56, bottom: size * 0.78 }
  const halfAt = (y: number): number => {
    if (y < capTop || y > bottom) return 0
    if (y < shoulderTop) return neckHalf
    if (y < shoulderBottom) {
      const t = (y - shoulderTop) / (shoulderBottom - shoulderTop)
      return neckHalf + (bodyHalf - neckHalf) * Math.sin((t * Math.PI) / 2)
    }
    return bodyHalf
  }
  for (let y = 0; y < size; y++) {
    const half = halfAt(y)
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4
      const ground = 238 - (y / size) * 26
      let r = ground
      let g = ground - 2
      let b = ground - 8
      const dx = Math.abs(x - size / 2)
      if (half > 0 && dx < half) {
        const across = dx / half
        const shade = 1 - across * across * 0.5
        const cap = y < capBottom
        r = (cap ? 58 : glass[0]) * shade
        g = (cap ? 48 : glass[1]) * shade
        b = (cap ? 40 : glass[2]) * shade
        // The highlight glass has down one shoulder.
        const highlight = Math.max(0, 1 - Math.abs(x - (size / 2 - half * 0.5)) / (half * 0.22))
        r = Math.min(255, r + highlight * 80)
        g = Math.min(255, g + highlight * 78)
        b = Math.min(255, b + highlight * 66)
        if (y > label.top && y < label.bottom) {
          r = 243
          g = 238
          b = 226
          const rule = size * 0.004
          if (
            Math.abs(y - (label.top + size * 0.05)) < rule ||
            Math.abs(y - (label.bottom - size * 0.05)) < rule
          ) {
            r = 128
            g = 98
            b = 50
          }
        }
      }
      const grain = (noise() - 0.5) * 4
      data[i] = Math.max(0, Math.min(255, Math.round(r + grain)))
      data[i + 1] = Math.max(0, Math.min(255, Math.round(g + grain)))
      data[i + 2] = Math.max(0, Math.min(255, Math.round(b + grain)))
      data[i + 3] = 255
    }
  }
  return { width: size, height: size, data }
}

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
          'Its <em>shape</em> is code — <code>schema/document-types/home-page.toml</code> — and the ' +
          'markup around it is <code>Views/homePage.tsx</code>.</p>' +
          '<p>Add a property to the TOML, run <code>bunbraco schema check</code> to see what it would ' +
          'do to this page, then <code>bunbraco start</code> to apply it.</p>',
      ),
    },
  })
}

const HARBOURSTONE: Builder = async (site) => {
  const { page, element, image } = await writers(site)

  const harbour = await image({
    key: '2462ad2e-8038-46ab-920c-af66ca5143a9',
    name: 'The harbour at dawn',
    file: 'harbour-at-dawn.jpg',
    pixels: coastline(1600, 900, 3),
  })
  const warehouse = await image({
    key: 'a386a383-d4dd-421f-9afa-e1bdc711713b',
    name: 'Dunnage warehouse by the water',
    file: 'warehouse.jpg',
    pixels: coastline(1600, 900, 11),
  })
  const bottleTwelve = await image({
    key: 'ce973ab0-62cd-40d1-930a-78ee4e467e60',
    name: 'Harbourstone 12 Year Old',
    file: 'bottle-12.jpg',
    pixels: bottle(800, 5, [176, 126, 58]),
  })
  const bottlePeated = await image({
    key: '913c89e8-c3a1-4722-b37f-0e4d44a71d8f',
    name: 'Harbourstone Peated',
    file: 'bottle-peated.jpg',
    pixels: bottle(800, 9, [138, 104, 62]),
  })
  const bottleCask = await image({
    key: '6a26db3b-1f16-48b1-8283-0277e2fbc186',
    name: 'Harbour Cask 2026',
    file: 'bottle-harbour-cask.jpg',
    pixels: bottle(800, 17, [198, 142, 70]),
  })

  const note = (key: string, aspect: string, text: string) =>
    element({
      key,
      type: 'tastingNote',
      name: `${aspect} — ${text.slice(0, 28)}…`,
      values: { aspect, note: text },
    })

  const twelveNotes = [
    await note(
      '483a0d3b-a10c-4c9d-8c81-d9607d37e968',
      'Nose',
      'Sea pink and cut hay, with a lick of salt off the harbour wall.',
    ),
    await note(
      '88ec1185-53b5-439a-a2ce-3f56603be4ff',
      'Palate',
      'Soft oak and pear skin, then barley sugar; the brine arrives late and politely.',
    ),
    await note(
      'b4e38bbd-c1a3-431a-b7a9-5868aa32993a',
      'Finish',
      'Long, floral, faintly saline — the sea air again, on the way out.',
    ),
  ]
  const peatedNotes = [
    await note(
      '22144db2-e214-4006-a0bb-53b5bd121fd6',
      'Nose',
      'Driftwood smoke over gorse flower, damp rope, a squeeze of lemon.',
    ),
    await note(
      '4b760c0b-b83a-4eee-aa29-c225cfabf19b',
      'Palate',
      'Soft oak under the smoke, white pepper, sea spray on warm stone.',
    ),
    await note(
      '97469df2-107c-4010-8c14-4de88f735529',
      'Finish',
      'Ash and heather honey, drying slowly to salt.',
    ),
  ]
  const caskNotes = [
    await note(
      'b1876d3a-50a7-4358-84bf-a0899932ffa9',
      'Nose',
      'Orchard blossom and oak shavings, bright and undiluted.',
    ),
    await note(
      '2fe03891-1294-4344-8e24-47e8b212e5b0',
      'Palate',
      'Thick soft oak, apricot, cracked black pepper and a wash of salt.',
    ),
    await note(
      'f36dd4a9-927c-4ca3-a790-c9c859ac7302',
      'Finish',
      'Warm, floral, very long; water opens the sea air right up.',
    ),
  ]

  const home = await page({
    key: 'd60ef12b-0f0a-4db5-9763-21fa52b8d4da',
    type: 'homePage',
    name: 'Harbourstone',
    values: {
      title: 'Harbourstone Distillery',
      strapline: 'Coastal single malt, matured within sight of the water',
      heroImage: pick(harbour),
      intro: richtext(
        '<p>We fill into soft oak and leave it by the sea. The warehouses stand close enough to the ' +
          'water that the air works on the casks all year: the spirit comes out floral and gentle, ' +
          'with the salt that only a coastal maturation gives.</p>' +
          '<p>Three bottlings, a small still house, and an open door most of the year.</p>',
      ),
    },
  })

  const range = await page({
    key: '2efbdb5b-7888-4a49-bca5-c0f85b76e472',
    type: 'whiskyList',
    parent: home,
    name: 'Our Whisky',
    values: {
      title: 'Our Whisky',
      summary: 'Three bottlings: the 12, the peated 10 and this year’s harbour cask.',
      intro: richtext(
        '<p>Everything we bottle is matured here on the coast. Soft oak first, floral always, and ' +
          'the salt air underneath it.</p>',
      ),
    },
  })

  await page({
    key: '6ad8f0f3-9334-47f1-b805-80c4b4b4fa88',
    type: 'expression',
    parent: range,
    name: 'Harbourstone 12',
    values: {
      title: 'Harbourstone 12 Year Old',
      age: 12,
      abv: '46.3%',
      bottleImage: pick(bottleTwelve),
      bodyText: richtext(
        '<p>Twelve years in refill American oak, in the low warehouse nearest the pier. Bottled at ' +
          '46.3%, never chill-filtered, no colouring.</p>',
      ),
      tastingNotes: twelveNotes,
    },
  })
  await page({
    key: 'a562f0a2-cb6e-4ead-a1ce-4d180632419f',
    type: 'expression',
    parent: range,
    name: 'Harbourstone Peated',
    values: {
      title: 'Harbourstone Peated',
      age: 10,
      abv: '48.0%',
      bottleImage: pick(bottlePeated),
      bodyText: richtext(
        '<p>Ten years, lightly peated to 18ppm with local turf, and the same coastal warehousing. ' +
          'The smoke sits on top; the floral spirit is still underneath it.</p>',
      ),
      tastingNotes: peatedNotes,
    },
  })
  await page({
    key: 'cd681b4b-9c4e-4624-9c13-450aa6a9c135',
    type: 'expression',
    parent: range,
    name: 'Harbour Cask 2026',
    values: {
      title: 'Harbour Cask 2026',
      abv: '57.1%',
      bottleImage: pick(bottleCask),
      bodyText: richtext(
        '<p>One cask, drawn at full strength for this year&rsquo;s release. No age statement: it was ' +
          'ready, which is the only argument that matters. 312 bottles.</p>',
      ),
      tastingNotes: caskNotes,
    },
  })

  await page({
    key: 'cb4c569e-c28a-43b6-a4d7-d33bb544e973',
    type: 'contentPage',
    parent: home,
    name: 'The Distillery',
    values: {
      title: 'The Distillery',
      summary: 'Two stills, long fermentations, and warehouses twenty metres from the water.',
      heroImage: pick(warehouse),
      bodyText: richtext(
        '<p>Two stills, run slowly, with long fermentations and a tall lyne arm — which is where the ' +
          'floral character comes from. We fill at 63.5% into soft oak, mostly refill, and roll the ' +
          'casks into dunnage warehouses twenty metres from the high-water mark.</p>' +
          '<h2>The water</h2>' +
          '<p>Soft, peat-filtered, from the burn behind the distillery. Hard water makes a heavier ' +
          'spirit; we are after the opposite.</p>' +
          '<h2>The warehouses</h2>' +
          '<p>Earth floors, three casks high, salt on the walls. Nothing is temperature-controlled: ' +
          'the sea does that, and does it better.</p>',
      ),
    },
  })

  await page({
    key: '62695966-b12c-4a56-a3fc-310d23f8a6e4',
    type: 'contentPage',
    parent: home,
    name: 'Visit',
    values: {
      title: 'Visit',
      summary: 'Tours at 11.00 and 14.00, Tuesday to Saturday, finishing in the warehouse.',
      bodyText: richtext(
        '<p>The still house is open Tuesday to Saturday. Tours run at 11.00 and 14.00 and finish in ' +
          'the warehouse with three drams, including whatever is in the cask we are filling.</p>' +
          '<h2>Opening hours</h2>' +
          '<ul><li>Tuesday to Friday: 10.00&ndash;17.00</li><li>Saturday: 10.00&ndash;16.00</li>' +
          '<li>Sunday and Monday: closed</li></ul>' +
          '<p>Dogs are welcome in the yard. The warehouse floor is uneven; tell us in advance if ' +
          'that is a problem and we will take the tour another way round.</p>',
      ),
    },
  })

  const journal = await page({
    key: '5f3eb924-146f-4ca3-b477-5abb4af2ea32',
    type: 'journal',
    parent: home,
    name: 'Journal',
    values: {
      title: 'Journal',
      summary: 'Filling notes, warehouse weather, and the occasional opinion.',
      intro: richtext('<p>Filling notes, warehouse weather, and the occasional opinion.</p>'),
    },
  })
  await page({
    key: '26cd36fc-b9f5-4ebc-9d24-666567ebeb3e',
    type: 'journalEntry',
    parent: journal,
    name: 'Filling the first cask of 2026',
    values: {
      title: 'Filling the first cask of 2026',
      publishedOn: '2026-02-11T09:30:00',
      summary:
        'A refill hogshead, 63.5%, and the warehouse door open to a south-westerly for the whole afternoon.',
      heroImage: pick(warehouse),
      bodyText: richtext(
        '<p>Cask 2026/001 went into the far corner of warehouse two this morning: a refill American ' +
          'oak hogshead, filled at 63.5% from the middle of the run.</p>' +
          '<p>The spirit is floral to the point of being obvious about it — orchard blossom, a little ' +
          'pear — and the oak will soften that rather than cover it. Ask us again in twelve years.</p>',
      ),
    },
  })
  await page({
    key: 'ead3325b-ac35-4f46-b6c6-cecf0a4f5965',
    type: 'journalEntry',
    parent: journal,
    name: 'What the sea air actually does',
    values: {
      title: 'What the sea air actually does',
      publishedOn: '2026-04-02T08:00:00',
      summary:
        'Salt on the warehouse walls is easy to romanticise. Here is what we can measure, and what we cannot.',
      heroImage: pick(harbour),
      bodyText: richtext(
        '<p>We lose a little under 2% a year in the seaward warehouses and closer to 1.4% inland, ' +
          'which is the humidity rather than anything mystical.</p>' +
          '<p>The saline note in the 12 is real and we are not going to pretend we can prove where ' +
          'it comes from. Earth floors, damp air, soft oak, time. That is the whole method.</p>',
      ),
    },
  })

  await page({
    key: '3d312cc8-2937-40e1-ba14-fd781c9a862d',
    type: 'contentPage',
    parent: home,
    name: 'Contact',
    values: {
      title: 'Contact',
      summary: 'Where we are, and who to ask for.',
      bodyText: richtext(
        '<p>Harbourstone Distillery, Craigard Point, Argyll</p>' +
          '<p>enquiries@harbourstone.example &middot; +44 (0)1234 567890</p>' +
          '<p>Trade and wholesale: ask for Mairi.</p>',
      ),
      // A `formPicker` stores the form's UUID, which is the `key` in
      // `files/schema/forms/visit-enquiry.toml`. Written here rather than left
      // for someone to pick in the backoffice, so the demo arrives with a
      // working form on the page.
      enquiryForm: '7b1f4c20-9a63-4e18-8d25-3c6f5a1e9b04',
    },
  })
}

const BUILDERS: Record<string, Builder> = {
  basic: BASIC,
  'demo/harbourstone': HARBOURSTONE,
}

/**
 * A template's bundle id is fixed, not generated: `start --bundle` imports once
 * per id, so a rebuild must not look like a different bundle to a site that
 * already has this content.
 */
const BUNDLE_IDS: Record<string, string> = {
  basic: '2de473a2-d391-4161-801e-e34b202759b8',
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
