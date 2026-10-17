/**
 * The command line reference as HTML, for the product site's developer pages:
 * built from the CLI manifest's data, through the same clispec description
 * `crombolo schema` prints, so the page cannot say anything the CLI does not.
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

/** The reference, grouped by the first word of each command. */
export function cliReferenceHtml(manifest: Interfaces.Manifest): string {
  const document = clispecDocument({
    bin: 'crombolo',
    version: manifest.version,
    commands: Object.values(manifest.commands),
  })
  const groups = new Map<string, typeof document.commands>()
  for (const command of document.commands) {
    const group = String(command.name).split(' ')[0] as string
    groups.set(group, [...(groups.get(group) ?? []), command])
  }
  const parts: string[] = [
    '<p>Every command, generated from the CLI itself. Each takes ' +
      `${code('--help')} for this page's entry, and ${code('-o json')} for a result a script can read. ` +
      `${code('crombolo schema')} prints the same description for a machine, as a ` +
      '<a href="https://clispec.dev">clispec</a> document.</p>',
  ]
  for (const [group, commands] of groups) {
    parts.push(`<h2 id="${escapeHtml(group)}">${escapeHtml(group)}</h2>`)
    for (const command of commands) {
      const name = String(command.name)
      const args = ((command.args as Arg[] | undefined) ?? []).slice()
      parts.push(
        `<h3 id="${escapeHtml(name.replaceAll(' ', '-'))}">${code(`crombolo ${name}`)}</h3>`,
      )
      parts.push(
        `<p>${escapeHtml(sentence(String(command.description)))} ${EFFECTS[String(command.effects)] ?? ''}</p>`,
      )
      parts.push(`<pre><code>${escapeHtml(usage(name, args))}</code></pre>`)
      if (args.length > 0)
        parts.push(
          `<table><thead><tr><th>Argument</th><th>What it is</th></tr></thead><tbody>${args.map(argRow).join('')}</tbody></table>`,
        )
    }
  }
  parts.push('<h2 id="exit-codes">Exit codes</h2>')
  parts.push(
    `<p>A failure exits with its kind's code; with ${code('-o json')}, or whenever stderr is not a terminal, ` +
      "the last line of stderr is a JSON envelope naming the kind. A check that finds what it looks for exits with an outcome's code, and its findings are its output.</p>",
  )
  const rows = [
    ...document.errors.map((e) => [String(e.exit_code), e.kind, e.description] as const),
    ...document.outcomes.map((o) => [String(o.code), o.name, o.description] as const),
  ].sort((a, b) => Number(a[0]) - Number(b[0]))
  parts.push(
    `<table><thead><tr><th>Code</th><th>Kind</th><th>When</th></tr></thead><tbody>${rows
      .map(
        ([codeNumber, kind, description]) =>
          `<tr><td>${codeNumber}</td><td>${code(kind)}</td><td>${escapeHtml(description).replaceAll(/`([^`]+)`/g, '<code>$1</code>')}</td></tr>`,
      )
      .join('')}</tbody></table>`,
  )
  return parts.join('\n')
}
