/**
 * The command line reference as HTML, for the product site's docs: built from
 * the CLI manifest's data, through the same clispec description
 * `crombolo schema` prints, so the pages cannot say anything the CLI does not.
 */
import type { Interfaces } from '@oclif/core'
import { clispecDocument } from './clispec.ts'

const escapeHtml = (text: string): string =>
  text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')

const code = (text: string) => `<code>${escapeHtml(text)}</code>`

interface Arg {
  name: string
  type: string
  short?: string
  required?: boolean
  default?: unknown
  enum?: unknown[]
  description?: string
}

/** One page of the reference: the topics, by the first word of a command, it covers. */
export interface CliPageSpec {
  slug: string
  title: string
  summary: string
  topics: readonly string[]
}

/** Where each topic is documented. A new topic has to be placed here, or the reference test fails. */
export const CLI_PAGES: readonly CliPageSpec[] = [
  {
    slug: 'sites',
    title: 'Sites',
    summary: 'Create a site, start it, check on it, and describe the command line to a script.',
    topics: ['init', 'start', 'status', 'health', 'generate', 'export', 'schema'],
  },
  {
    slug: 'types',
    title: 'Content types',
    summary: 'Check, apply and change the content model kept in schema/.',
    topics: ['types'],
  },
  {
    slug: 'components',
    title: 'Components and assets',
    summary:
      'Create and check the templates under components/, and the styles and scripts beside them.',
    topics: ['components', 'assets'],
  },
  {
    slug: 'content',
    title: 'Content and media',
    summary: 'Pages, media, the dictionary, domains and the recycle bin.',
    topics: ['content', 'media', 'dictionary', 'domains', 'recycle-bin'],
  },
  {
    slug: 'remotes',
    title: 'Remotes, pull and push',
    summary: 'Sign in to another environment, and move content and schema between them.',
    topics: ['login', 'logout', 'whoami', 'remote', 'pull', 'push', 'bundle'],
  },
  {
    slug: 'import',
    title: 'Importing from Umbraco',
    summary: 'Bring an Umbraco site’s content types, content and media across.',
    topics: ['import'],
  },
  {
    slug: 'users',
    title: 'Users and access',
    summary: 'Back office users, the administrator’s password and API clients.',
    topics: ['users', 'admin', 'api-client'],
  },
  {
    slug: 'operations',
    title: 'Operations',
    summary: 'Caches, the search index, maintenance pauses and upgrades.',
    topics: ['cache', 'index', 'maintenance', 'upgrade'],
  },
]

export interface CliReferencePage extends CliPageSpec {
  html: string
  /** The commands on the page, as typed: `content publish`. */
  commands: string[]
}

function usage(name: string, args: Arg[]): string {
  const words = args.map((arg) => {
    if (!arg.name.startsWith('--')) return arg.required ? `<${arg.name}>` : `[<${arg.name}>]`
    const flag = arg.type === 'boolean' ? arg.name : `${arg.name} <${arg.name.slice(2)}>`
    return arg.required ? flag : `[${flag}]`
  })
  return ['crombolo', name, ...words].join(' ')
}

/** A summary written for `--help` — "apply schema/ to the database" — as a sentence. */
const sentence = (text: string): string => {
  const trimmed = text.trim()
  if (!trimmed) return ''
  const capital = `${trimmed.charAt(0).toUpperCase()}${trimmed.slice(1)}`
  return /[.!?]$/.test(capital) ? capital : `${capital}.`
}

function argRow(arg: Arg): string {
  const name = [arg.short, arg.name].filter(Boolean).join(', ')
  const notes = [
    arg.description ? escapeHtml(sentence(arg.description)) : '',
    arg.enum ? `One of ${arg.enum.map((v) => code(String(v))).join(', ')}.` : '',
    arg.default !== undefined ? `Default ${code(String(arg.default))}.` : '',
    arg.required ? 'Required.' : '',
  ]
    .filter(Boolean)
    .join(' ')
  return `<tr><td>${code(name)}</td><td>${notes}</td></tr>`
}

const EFFECTS: Record<string, string> = {
  read_only: 'Changes nothing.',
  idempotent: 'Safe to run again: a second run changes nothing more.',
  non_idempotent: 'Each run acts again.',
}

const documentOf = (manifest: Interfaces.Manifest) =>
  clispecDocument({
    bin: 'crombolo',
    version: manifest.version,
    commands: Object.values(manifest.commands),
  })

type Command = ReturnType<typeof documentOf>['commands'][number]

const topicOf = (command: Command) => String(command.name).split(' ')[0] as string

/** The anchor a command has on its page: `content publish` → `content-publish`. */
export const commandAnchor = (name: string): string => name.replaceAll(' ', '-')

function commandHtml(command: Command): string {
  const name = String(command.name)
  const args = ((command.args as Arg[] | undefined) ?? []).slice()
  const parts = [
    `<h2 id="${escapeHtml(commandAnchor(name))}">${code(`crombolo ${name}`)}</h2>`,
    `<p>${escapeHtml(sentence(String(command.description)))} ${EFFECTS[String(command.effects)] ?? ''}</p>`,
    `<pre><code>${escapeHtml(usage(name, args))}</code></pre>`,
  ]
  if (args.length > 0)
    parts.push(
      `<table><thead><tr><th>Argument</th><th>What it is</th></tr></thead><tbody>${args.map(argRow).join('')}</tbody></table>`,
    )
  return parts.join('\n')
}

/** The topics no page in `CLI_PAGES` covers. */
export function unplacedTopics(manifest: Interfaces.Manifest): string[] {
  const placed = new Set(CLI_PAGES.flatMap((page) => page.topics))
  return [...new Set(documentOf(manifest).commands.map(topicOf))].filter((t) => !placed.has(t))
}

/**
 * One page per entry in `CLI_PAGES`, in its order. A topic no page names — a
 * plugin's, say — gets a page of its own after them, so nothing is dropped.
 */
export function cliReferencePages(manifest: Interfaces.Manifest): CliReferencePage[] {
  const commands = documentOf(manifest).commands
  const specs = [
    ...CLI_PAGES,
    ...unplacedTopics(manifest).map((topic) => ({
      slug: topic,
      title: topic,
      summary: `The ${topic} commands.`,
      topics: [topic],
    })),
  ]
  return specs
    .map((spec) => {
      const on = spec.topics.flatMap((topic) => commands.filter((c) => topicOf(c) === topic))
      return {
        ...spec,
        commands: on.map((c) => String(c.name)),
        html: on.map(commandHtml).join('\n'),
      }
    })
    .filter((page) => page.commands.length > 0)
}

/** The front page of the reference: what every command shares, then each page and its commands. */
export function cliIndexHtml(pages: readonly CliReferencePage[], base: string): string {
  const parts = [
    `<p>Every command, generated from the CLI itself. Each takes ${code('--help')} for its entry ` +
      `here, and ${code('-o json')} for a result a script can read. ${code('crombolo schema')} prints ` +
      'the same description for a machine, as a <a href="https://clispec.dev">clispec</a> document. ' +
      'A command that fails exits with a code saying why: see the <a href="/docs/reference/exit-codes/">exit codes</a>.</p>',
  ]
  for (const page of pages) {
    const url = `${base}${page.slug}/`
    parts.push(
      `<h2 id="${escapeHtml(page.slug)}"><a href="${url}">${escapeHtml(page.title)}</a></h2>`,
    )
    parts.push(`<p>${escapeHtml(page.summary)}</p>`)
    parts.push(
      `<ul>${page.commands
        .map(
          (name) =>
            `<li><a href="${url}#${commandAnchor(name)}">${code(`crombolo ${name}`)}</a></li>`,
        )
        .join('')}</ul>`,
    )
  }
  return parts.join('\n')
}

/** The exit codes and the error envelope, from the CLI's own list. */
export function exitCodesHtml(manifest: Interfaces.Manifest): string {
  const document = documentOf(manifest)
  const rows = [
    ...document.errors.map((e) => [String(e.exit_code), e.kind, e.description] as const),
    ...document.outcomes.map((o) => [String(o.code), o.name, o.description] as const),
  ].sort((a, b) => Number(a[0]) - Number(b[0]))
  return [
    '<h2 id="codes">The codes</h2>',
    `<p>A command that succeeds exits with ${code('0')}. A failure exits with its kind's code, and a ` +
      "check that finds what it looks for exits with an outcome's code, its findings being its output.</p>",
    `<table><thead><tr><th>Code</th><th>Kind</th><th>When</th></tr></thead><tbody>${rows
      .map(
        ([codeNumber, kind, description]) =>
          `<tr><td>${codeNumber}</td><td>${code(kind)}</td><td>${escapeHtml(description).replaceAll(/`([^`]+)`/g, '<code>$1</code>')}</td></tr>`,
      )
      .join('')}</tbody></table>`,
    '<h2 id="envelope">The error envelope</h2>',
    `<p>With ${code('-o json')}, or whenever stderr is not a terminal, the last line of stderr is a JSON ` +
      'object naming the kind, so a script can tell a missing page from a refused one without reading the message.</p>',
    `<pre><code>${escapeHtml(
      JSON.stringify(
        {
          error: {
            kind: 'not_found',
            message: 'There is no page at /about/team.',
            hint: "Check the page's path or key.",
            exit_code: 5,
          },
        },
        null,
        2,
      ),
    )}</code></pre>`,
    `<p>${code('hint')}, ${code('details')} and ${code('retryable')} appear only when there is something to say.</p>`,
  ].join('\n')
}
