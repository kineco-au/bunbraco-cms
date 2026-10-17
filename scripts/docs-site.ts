/**
 * The product site's docs section, as data for `build:template` to write: the
 * guides in `sites/crombolo/docs/`, rendered from Markdown, and the reference
 * pages generated from the command line and the server's settings list.
 * `docs/stories/05_completed/157-a-docs-section-on-the-product-site.md`.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { SETTING_SECTIONS, SETTINGS, type Setting } from '@crombolo/server'
import { Marked, type Tokens } from 'marked'
import {
  type CliReferencePage,
  cliIndexHtml,
  cliReferencePages,
  exitCodesHtml,
} from '../packages/cli/src/reference.ts'
import { ROOT } from './packages.ts'

export const DOCS_DIR = join(ROOT, 'sites/crombolo/docs')
type Manifest = Parameters<typeof cliReferencePages>[0]

const EDIT_BASE = 'https://github.com/kineco-au/crombolo-cms/edit/main/sites/crombolo/docs'
export const CLI_BASE = '/docs/reference/command-line/'

/** A docs page as the build writes it: one node, keyed by where it sits. */
export interface DocsPage {
  /** Its address under `/docs/`, without slashes: `guides/remotes`. */
  path: string
  name: string
  slug: string
  standfirst?: string
  body?: string
  generatedFrom?: string
  editUrl?: string
  children: DocsPage[]
}

const escapeHtml = (text: string): string =>
  text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')

const slugify = (text: string): string =>
  text
    .toLowerCase()
    .replaceAll(/<[^>]+>/g, '')
    .replaceAll(/&[a-z#0-9]+;/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')

/** Markdown to the markup the rich-text editor stores; headings get ids for "On this page". */
export function renderMarkdown(markdown: string): string {
  const seen = new Map<string, number>()
  const marked = new Marked({ gfm: true })
  marked.use({
    renderer: {
      heading(this: { parser: { parseInline(tokens: Tokens.Generic[]): string } }, token) {
        const inner = this.parser.parseInline(token.tokens)
        const base = slugify(inner) || 'section'
        const n = seen.get(base) ?? 0
        seen.set(base, n + 1)
        const id = n === 0 ? base : `${base}-${n + 1}`
        return `<h${token.depth} id="${id}">${inner}</h${token.depth}>\n`
      },
    },
  })
  return (marked.parse(markdown, { async: false }) as string).trim()
}

export interface Guide {
  file: string
  title: string
  summary: string
  order: number
  body: string
}

/** A guide's front matter and body. Every field is required, so a page cannot ship half-described. */
export function parseGuide(file: string, text: string): Guide {
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text)
  if (!match) throw new Error(`${file}: no front matter`)
  const fields = new Map<string, string>()
  for (const line of (match[1] as string).split('\n')) {
    const at = line.indexOf(':')
    if (at > 0) fields.set(line.slice(0, at).trim(), line.slice(at + 1).trim())
  }
  const need = (name: string) => {
    const value = fields.get(name)
    if (!value) throw new Error(`${file}: front matter has no "${name}"`)
    return value
  }
  const order = Number(need('order'))
  if (!Number.isFinite(order)) throw new Error(`${file}: "order" is not a number`)
  const body = (match[2] as string).trim()
  if (/^# /m.test(body)) throw new Error(`${file}: the title is the page's heading; start at ##`)
  return { file, title: need('title'), summary: need('summary'), order, body }
}

function readGuides(dir: string): Guide[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((name) => name.endsWith('.md'))
    .map((name) => parseGuide(name, readFileSync(join(dir, name), 'utf8')))
    .sort((a, b) => a.order - b.order || a.file.localeCompare(b.file))
}

const guidePage = (folder: string, guide: Guide): DocsPage => {
  const slug = basename(guide.file, '.md')
  const relative = folder ? `${folder}/${guide.file}` : guide.file
  return {
    path: folder ? `${folder}/${slug}` : slug,
    name: guide.title,
    slug,
    standfirst: guide.summary,
    body: renderMarkdown(guide.body),
    editUrl: `${EDIT_BASE}/${relative}`,
    children: [],
  }
}

const KIND_NOTES: Record<Setting['kind'], string> = {
  string: '',
  number: 'A number.',
  boolean: '<code>true</code> or <code>false</code>.',
  list: 'A comma-separated list.',
  enum: '',
}

function settingRow(setting: Setting): string {
  const notes = [
    escapeHtml(setting.description),
    setting.kind === 'enum' && setting.values
      ? `One of ${setting.values.map((v) => `<code>${escapeHtml(v)}</code>`).join(', ')}.`
      : KIND_NOTES[setting.kind],
    setting.appliesTo === 'cli' ? 'Read by the command line only.' : '',
    setting.secret ? 'Keep this secret: it is never shown back.' : '',
  ]
    .filter(Boolean)
    .join(' ')
  const value = setting.default === undefined ? '—' : `<code>${escapeHtml(setting.default)}</code>`
  return `<tr><td><code>${escapeHtml(setting.env)}</code></td><td>${value}</td><td>${notes}</td></tr>`
}

/** Every setting, a table per section in the list's order. */
export function configurationHtml(settings: readonly Setting[] = SETTINGS): string {
  const parts = [
    '<p>Every setting the server and the command line read from the environment. A value in ' +
      '<code>crombolo.config.ts</code> wins over the environment, and the environment over the default. ' +
      'See the <a href="/docs/guides/configuration/">configuration guide</a> for where to start.</p>',
  ]
  for (const section of SETTING_SECTIONS) {
    const rows = settings.filter((setting) => setting.section === section)
    if (rows.length === 0) continue
    parts.push(`<h2 id="${slugify(section)}">${escapeHtml(section)}</h2>`)
    parts.push(
      `<table><thead><tr><th>Setting</th><th>Default</th><th>What it does</th></tr></thead><tbody>${rows
        .map(settingRow)
        .join('')}</tbody></table>`,
    )
  }
  return parts.join('\n')
}

const commandLinePage = (page: CliReferencePage): DocsPage => ({
  path: `reference/command-line/${page.slug}`,
  name: page.title,
  slug: page.slug,
  standfirst: page.summary,
  body: page.html,
  generatedFrom: 'the command line’s own description of its commands',
  children: [],
})

/** The whole docs tree under the section, in reading order. */
export function docsTree(manifest: Manifest, dir = DOCS_DIR): DocsPage[] {
  const top = readGuides(dir).map((guide) => guidePage('', guide))
  const guides = readGuides(join(dir, 'guides')).map((guide) => guidePage('guides', guide))
  const commands = cliReferencePages(manifest)
  return [
    ...top,
    {
      path: 'guides',
      name: 'Guides',
      slug: 'guides',
      standfirst: 'How the pieces fit together, from the content model to running in production.',
      children: guides,
    },
    {
      path: 'reference',
      name: 'Reference',
      slug: 'reference',
      standfirst: 'Every command, setting and exit code, generated from the product itself.',
      children: [
        {
          path: 'reference/command-line',
          name: 'Command line',
          slug: 'command-line',
          standfirst: 'Every crombolo command: what it takes, what it changes and how it fails.',
          body: cliIndexHtml(commands, CLI_BASE),
          generatedFrom: 'the command line’s own description of its commands',
          children: commands.map(commandLinePage),
        },
        {
          path: 'reference/configuration',
          name: 'Configuration',
          slug: 'configuration',
          standfirst: 'Every setting, its default and what it does.',
          body: configurationHtml(),
          generatedFrom: 'the list of settings the server reads',
          children: [],
        },
        {
          path: 'reference/exit-codes',
          name: 'Exit codes',
          slug: 'exit-codes',
          standfirst: 'What each exit code means, and the error a script can read.',
          body: exitCodesHtml(manifest),
          generatedFrom: 'the command line’s list of errors',
          children: [],
        },
      ],
    },
  ]
}

/** A uuid-shaped digest of a seed: the same page gets the same key on every build. */
export function stableKey(seed: string): string {
  const hex = new Bun.CryptoHasher('sha256').update(seed).digest('hex')
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    `4${hex.slice(13, 16)}`,
    `8${hex.slice(17, 20)}`,
    hex.slice(20, 32),
  ].join('-')
}

export const docsKey = (path: string): string => stableKey(`docs:${path}`)
