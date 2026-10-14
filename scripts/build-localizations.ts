/**
 * Generates a backoffice localisation override per UI language.
 *
 * `plugin/branding/localization-en.js` is hand-written, and the keys it covers
 * are the editorial decision about which strings name the product rather than a
 * real .NET thing: `appsettings.json`, IIS permissions and the installer are
 * deliberately left alone. This takes that same key set and, for every other
 * language the vendored client ships a dictionary for, rewrites the product
 * name in that language's own wording. Every language, English included, also
 * says "content type" wherever Umbraco says "document type" (`TERMS`).
 *
 * Run as the last step of `vendor:backoffice`, or on its own with
 * `bun run localizations:build`.
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import english from '../packages/backoffice-host/plugin/branding/localization-en.js'
import { PLUGIN_PATH_PLACEHOLDER } from '../packages/backoffice-host/src/paths.ts'

const ROOT = join(import.meta.dir, '..')
const VENDOR_MANIFEST = join(
  ROOT,
  'packages/backoffice-dist/dist/packages/core/localization/manifests.js',
)
const LANG_DIR = join(ROOT, 'packages/backoffice-dist/dist/assets/lang')
const PLUGIN_DIR = join(ROOT, 'packages/backoffice-host/plugin')
const OUT_DIR = join(PLUGIN_DIR, 'localizations')

/** The cultures the hand-written English override names the product for. */
const HAND_WRITTEN = new Set(['en', 'en-us'])

/**
 * Strings that name a configuration key or a path rather than the product. None
 * of the curated keys carry one in English, but a translator may have left an
 * example in, and renaming `Umbraco:CMS:Global:UseHttps` would be a lie.
 */
const NAMES_SOMETHING_REAL = /umbraco\.com|umbraco:|umbracocms|appsettings|web\.config|\/umbraco\//i

/** Every culture the client registers a dictionary file for, in manifest order. */
function vendoredCultures(): { culture: string; file: string }[] {
  const source = readFileSync(VENDOR_MANIFEST, 'utf8')
  const pattern =
    /culture:\s*'([^']+)'\s*\},\s*js:\s*\(\)\s*=>\s*import\('[^']*lang\/([^']+)\.js'\)/g
  const found: { culture: string; file: string }[] = []
  for (const [, matched, file] of source.matchAll(pattern)) {
    if (!matched || !file) continue
    found.push({ culture: matched.toLowerCase(), file })
  }
  return found
}

/**
 * French elides `de` before a vowel, so its dictionaries carry `d'Umbraco`.
 * Bunbraco opens on a consonant, where the elision is wrong — so the article
 * comes back rather than being left as `d'Bunbraco`.
 */
const ELIDED = /\bd['\u2019](?=Umbraco)/g

export function rebrand(value: string): string | undefined {
  if (!/umbraco/i.test(value) || NAMES_SOMETHING_REAL.test(value)) return undefined
  return value
    .replace(ELIDED, 'de ')
    .replaceAll('Umbraco', 'Bunbraco')
    .replaceAll('umbraco', 'bunbraco')
}

/** The `section.key` pairs the English override curates, flattened. */
export function curatedKeys(overrides: Record<string, Record<string, string>>): [string, string][] {
  return Object.entries(overrides).flatMap(([section, entries]) =>
    Object.keys(entries).map((key): [string, string] => [section, key]),
  )
}

/** The branded subset of one language's dictionary, or undefined if it names nothing. */
export function brandDictionary(
  dictionary: Record<string, Record<string, string> | undefined>,
  keys: readonly [string, string][],
): Record<string, Record<string, string>> | undefined {
  const branded: Record<string, Record<string, string>> = {}
  for (const [section, key] of keys) {
    const value = dictionary[section]?.[key]
    if (typeof value !== 'string') continue
    const corrected = rebrand(value)
    if (corrected === undefined) continue
    branded[section] ??= {}
    branded[section][key] = corrected
  }
  return Object.keys(branded).length > 0 ? branded : undefined
}

type Rewrite = [pattern: RegExp, replacement: string | ((...groups: string[]) => string)]

/** `upper` when the word being replaced was capitalised, otherwise `lower`. */
const cased = (first: string, upper: string, lower: string) =>
  first === first.toLowerCase() ? lower : upper

/**
 * Umbraco's "document type" is a content type here, as `schema/content-types/`
 * names it. Each entry rewrites the phrase in that language's own grammar,
 * changing only the modifier so the head noun keeps its case and number. The
 * replacement is the wording the language's dictionary already uses for "content
 * type" wherever it has one. Blueprints ("document templates") are left alone,
 * which is why nothing here matches the word for "document" on its own.
 */
const TERMS: Record<string, Rewrite[]> = {
  ar: [
    [/(?:ال)?أنواع الوثائق/gu, 'أنواع المحتوى'],
    [/أنواع وثائق/gu, 'أنواع محتوى'],
    [/نوع الوثيقة/gu, 'نوع المحتوى'],
    [/نوع وثيقة/gu, 'نوع محتوى'],
    [/النوع من الوثائق/gu, 'النوع من المحتوى'],
    [/أنواع مستندات/gu, 'أنواع محتوى'],
    [/نوع مستند/gu, 'نوع محتوى'],
  ],
  bs: [
    [/Dokument Tip/gu, 'Tip sadržaja'],
    [
      /([Tt]ip\p{L}*|[Vv]rst\p{L}*) ([Dd])okumen(?:ata|ta)/gu,
      (_, head, d) => `${head} ${cased(d, 'Sadržaja', 'sadržaja')}`,
    ],
  ],
  cs: [
    [/dokumentových typech/gu, 'typech obsahu'],
    [
      /([Tt]yp\p{L}*) ([Dd])okument(?:u|ů)/gu,
      (_, head, d) => `${head} ${cased(d, 'Obsahu', 'obsahu')}`,
    ],
  ],
  cy: [
    [/\bof Dogfen\b/gu, 'o Gynnwys'],
    [/\b([Mm])ath dogfen\b/gu, (_, m) => `${m}ath o gynnwys`],
    [/\bo ([Dd])dogfen(?:nau)?\b/gu, (_, d) => `o ${cased(d, 'Gynnwys', 'gynnwys')}`],
  ],
  da: [[/([Dd])okumenttype/gu, (_, d) => cased(d, 'Indholdstype', 'indholdstype')]],
  de: [
    [/Dokumenttype\b/gu, 'Inhaltstyp'],
    [/([Dd])okument(?:en)?-?[Tt]yp/gu, (_, d) => cased(d, 'Inhaltstyp', 'inhaltstyp')],
  ],
  es: [
    [/Documento \(tipo\)/gu, 'tipo de contenido'],
    [
      /([Tt]ipos?) de ([Dd])ocumentos?/gu,
      (_, head, d) => `${head} de ${cased(d, 'Contenido', 'contenido')}`,
    ],
  ],
  fr: [
    [
      /([Tt]ypes?) de ([Dd])ocuments?/gu,
      (_, head, d) => `${head} de ${cased(d, 'Contenu', 'contenu')}`,
    ],
  ],
  he: [
    [/סוגי מסמכים/gu, 'סוגי תוכן'],
    [/סוג מסמך/gu, 'סוג תוכן'],
    [/שדה מסמך/gu, 'סוג תוכן'],
  ],
  hr: [
    [
      /([Vv]rst\p{L}*) ([Dd])okumen(?:ata|ta)/gu,
      (_, head, d) => `${head} ${cased(d, 'Sadržaja', 'sadržaja')}`,
    ],
  ],
  it: [
    [/([Tt]ipi) documento/gu, '$1 di contenuto'],
    [
      /([Tt]ip[oi]) di ([Dd])ocumento/gu,
      (_, head, d) => `${head} di ${cased(d, 'Contenuto', 'contenuto')}`,
    ],
  ],
  ja: [[/ドキュメント ?(?:タイプ|型)/gu, 'コンテンツタイプ']],
  ko: [[/문서 ?(유형|타입)/gu, '콘텐츠 $1']],
  nb: [[/([Dd])okumenttype/gu, (_, d) => cased(d, 'Innholdstype', 'innholdstype')]],
  nl: [[/([Dd])ocumenttype/gu, (_, d) => cased(d, 'Inhoudstype', 'inhoudstype')]],
  pl: [
    [
      /([Tt]yp\p{L}*|[Rr]odzaj\p{L}*) ([Dd])okument(?:u|ów)/gu,
      (_, head, d) => `${head} ${cased(d, 'Treści', 'treści')}`,
    ],
  ],
  pt: [
    [
      /([Tt]ipos?) de ([Dd])ocumentos?/gu,
      (_, head, d) => `${head} de ${cased(d, 'Conteúdo', 'conteúdo')}`,
    ],
  ],
  'pt-br': [
    [
      /([Tt]ipos?) de ([Dd])ocumentos?/gu,
      (_, head, d) => `${head} de ${cased(d, 'Conteúdo', 'conteúdo')}`,
    ],
  ],
  ro: [
    [
      /([Tt]ip\p{L}*) de ([Dd])ocumente?/gu,
      (_, head, d) => `${head} de ${cased(d, 'Conținut', 'conținut')}`,
    ],
  ],
  ru: [
    [
      /([Тт]ип\p{L}*) ([Дд])окумент(?:ов|а|у)?/gu,
      (_, head, d) => `${head} ${cased(d, 'Контента', 'контента')}`,
    ],
  ],
  sv: [[/([Dd])okumentt?yp/gu, (_, d) => cased(d, 'Innehållstyp', 'innehållstyp')]],
  tr: [[/([Bb])elge ([Tt]ür)/gu, (_, b, head) => `${cased(b, 'İçerik', 'içerik')} ${head}`]],
  uk: [
    [
      /([Тт]ип\p{L}*) ([Дд])окумент(?:ів|а|у)?/gu,
      (_, head, d) => `${head} ${cased(d, 'Контенту', 'контенту')}`,
    ],
  ],
  vi: [[/([Ll])oại ([Tt])ài liệu/gu, (_, l, t) => `${l}oại ${cased(t, 'Nội', 'nội')} dung`]],
  zh: [[/(?:文档|文件)类型/gu, '内容类型']],
  'zh-tw': [[/(?:文檔|文件|檔案)(?:類型|種類|類別)/gu, '內容類型']],
}

/** English runs after every language's own rules: translators left some strings untranslated. */
const ENGLISH_TERM: Rewrite = [
  /\b([Dd])ocument([ -]?)([Tt])ype/g,
  (_, d, gap, t) => `${cased(d, 'Content', 'content')}${gap}${t}ype`,
]

/** The English phrase, for finding the keys that use it. */
export const DOCUMENT_TYPE = /document[\s-]?type/i

/** `value` with "document type" said as "content type" in `language`, or undefined if unchanged. */
export function reterm(language: string, value: string): string | undefined {
  let out = value
  for (const [pattern, replacement] of [...(TERMS[language] ?? []), ENGLISH_TERM])
    out = out.replace(pattern, replacement as string)
  return out === value ? undefined : out
}

/**
 * Sections describing Umbraco itself rather than this CMS — the Runway installer,
 * and what telemetry sends to Umbraco HQ. Neither is a flow here, and both name
 * Umbraco as the real thing it is, so they are left as the branding leaves them.
 */
const NOT_OURS = new Set(['installer', 'analytics'])

/** The `section.key` pairs whose English text says "document type". */
export function termKeys(
  english: Record<string, Record<string, string> | undefined>,
): [string, string][] {
  return Object.entries(english)
    .filter(([section]) => !NOT_OURS.has(section))
    .flatMap(([section, entries]) =>
      Object.entries(entries ?? {})
        .filter(([, value]) => typeof value === 'string' && DOCUMENT_TYPE.test(value))
        .map(([key]): [string, string] => [section, key]),
    )
}

/**
 * One language's overrides: the product name in the curated keys, and "content
 * type" in the keys that say "document type". English names the product in its
 * hand-written override, so for it `brandKeys` is empty and any key that file
 * already covers is skipped, to keep the two from competing for a key.
 */
export function localizeDictionary(
  language: string,
  dictionary: Record<string, Record<string, string> | undefined>,
  brandKeys: readonly [string, string][],
  terms: readonly [string, string][],
  handWritten: Record<string, Record<string, string>> = {},
): Record<string, Record<string, string>> | undefined {
  const out = brandDictionary(dictionary, brandKeys) ?? {}
  for (const [section, key] of terms) {
    if (handWritten[section]?.[key] !== undefined) continue
    const value = out[section]?.[key] ?? dictionary[section]?.[key]
    if (typeof value !== 'string') continue
    const corrected = reterm(language, value)
    if (corrected === undefined) continue
    out[section] ??= {}
    out[section][key] = corrected
  }
  return Object.keys(out).length > 0 ? out : undefined
}

/**
 * Its own namespace: English also has the hand-written `Bunbraco.Localization.EN`,
 * and the backoffice refuses a second extension with the same alias.
 */
export const aliasOf = (culture: string) =>
  `Bunbraco.Localization.Overrides.${culture.toUpperCase().replaceAll('-', '_')}`

export async function buildLocalizations(): Promise<number> {
  const handWritten = english as Record<string, Record<string, string>>
  const keys = curatedKeys(handWritten)
  const vendoredEnglish = (await import(join(LANG_DIR, 'en.js'))) as {
    default: Record<string, Record<string, string> | undefined>
  }
  const terms = termKeys(vendoredEnglish.default)
  const { version } = JSON.parse(
    readFileSync(join(PLUGIN_DIR, 'umbraco-package.json'), 'utf8'),
  ) as { version: string }

  rmSync(OUT_DIR, { recursive: true, force: true })
  mkdirSync(OUT_DIR, { recursive: true })

  const extensions: unknown[] = []
  for (const { culture, file } of vendoredCultures()) {
    const module = (await import(join(LANG_DIR, `${file}.js`))) as {
      default: Record<string, Record<string, string> | undefined>
    }
    const localized = HAND_WRITTEN.has(culture)
      ? localizeDictionary(file, module.default, [], terms, handWritten)
      : localizeDictionary(file, module.default, keys, terms)
    if (!localized) continue

    writeFileSync(
      join(OUT_DIR, `${culture}.js`),
      `// Generated by \`bun run localizations:build\`. Do not edit.\n` +
        `// The product name in this language's own wording, for the keys\n` +
        `// plugin/branding/localization-en.js curates, and "content type" where\n` +
        `// Umbraco says "document type".\n` +
        `export default ${JSON.stringify(localized, null, 2)}\n`,
    )
    extensions.push({
      type: 'localization',
      alias: aliasOf(culture),
      name: `Bunbraco Localization Overrides (${culture})`,
      weight: 0,
      meta: { culture },
      js: `${PLUGIN_PATH_PLACEHOLDER}/localizations/${culture}.js`,
    })
  }

  writeFileSync(
    join(OUT_DIR, 'umbraco-package.json'),
    `${JSON.stringify(
      {
        $schema: '../../../backoffice-dist/dist/umbraco-package-schema.json',
        name: 'Bunbraco Localizations',
        id: 'Bunbraco.Localizations',
        version,
        allowPublicAccess: false,
        extensions,
      },
      null,
      2,
    )}\n`,
  )
  return extensions.length
}

if (import.meta.main) {
  const count = await buildLocalizations()
  console.log(`localizations: ${count} cultures`)
}
