/**
 * Asking a person: a confirmation, a typed name, a passphrase. Every question
 * goes to stderr, so stdout stays the result; with no terminal to ask on, a
 * confirmation refuses at once, naming the flag that answers it, and never
 * reads stdin.
 */
import { type CromboloConfig, setting } from '@crombolo/server'
import { CliError } from '../errors.ts'
import * as ops from '../operations/commands.ts'

/** Where a script gives a bundle's passphrase, rather than typing it. */
export const PASSPHRASE_ENV = 'CROMBOLO_BUNDLE_PASSPHRASE'
export const MIN_PASSPHRASE = 12

export const interactive = (): boolean => process.stdin.isTTY === true

async function readLine(question: string): Promise<string> {
  process.stderr.write(`${question} `)
  for await (const line of console) return line
  return ''
}

/**
 * Asks before something that cannot be taken back. `answer` is what must be
 * typed (a name, or `y`); off a terminal it throws `confirmation_required`, and
 * a person who answers anything else gets `refused`.
 */
export async function confirm(
  question: string,
  options: { bypass: string; answer?: string; declined?: string },
): Promise<void> {
  if (!interactive())
    throw new CliError('confirmation_required', question.replace(/[?:]\s*$/, '.'), {
      hint: `Pass ${options.bypass} to go on without being asked.`,
    })
  const typed = (await readLine(question)).trim()
  const yes = options.answer === undefined ? /^y(es)?$/i.test(typed) : typed === options.answer
  if (!yes) throw new CliError('refused', options.declined ?? 'Nothing was changed.')
}

/** A line typed without echo. */
export async function readSecret(question: string): Promise<string> {
  process.stderr.write(question)
  const stdin = process.stdin
  stdin.setRawMode(true)
  stdin.resume()
  return new Promise((done) => {
    let typed = ''
    const onData = (chunk: Buffer) => {
      for (const char of chunk.toString('utf8')) {
        if (char === '\u0003') {
          process.stderr.write('\n')
          process.exit(130)
        }
        if (char === '\r' || char === '\n') {
          stdin.setRawMode(false)
          stdin.pause()
          stdin.off('data', onData)
          process.stderr.write('\n')
          done(typed)
          return
        }
        if (char === '\u007f' || char === '\b') typed = typed.slice(0, -1)
        else typed += char
      }
    }
    stdin.on('data', onData)
  })
}

/** Everything piped to stdin, without its trailing newline. */
export async function readStdin(): Promise<string> {
  return (await Bun.stdin.text()).replace(/\r?\n$/, '')
}

const needPassphrase = (what: string) =>
  new CliError('auth', `${what} needs a passphrase.`, {
    hint: `Set ${PASSPHRASE_ENV}, or run it in a terminal to be asked.`,
  })

/** The passphrase to open a bundle with, when it is sealed: the environment's, or asked for. */
export async function passphraseToOpen(
  target: string,
  config: CromboloConfig,
): Promise<string | undefined> {
  const given = setting(PASSPHRASE_ENV)
  if (given) return given
  let sealed = false
  try {
    sealed = ops.readBundle(target, config.siteDir).set.sealed === true
  } catch {
    // The command that follows reads it again and says what is wrong with it.
    return undefined
  }
  if (!sealed) return undefined
  if (!interactive()) throw needPassphrase(`${target} is encrypted: opening it`)
  return readSecret('  Passphrase for this bundle: ')
}

/** The passphrase for the people a file carries: the environment's, asked for, or none. */
export async function passphraseForPeople(): Promise<string | undefined> {
  return (
    setting(PASSPHRASE_ENV) ??
    (interactive() ? await readSecret('  Passphrase for its people: ') : undefined)
  )
}

/** A new passphrase to seal an export with: the environment's, or asked for twice. */
export async function passphraseToSeal(): Promise<string> {
  const given = setting(PASSPHRASE_ENV)
  if (given) {
    if (given.length < MIN_PASSPHRASE)
      throw new CliError('usage', `${PASSPHRASE_ENV} is shorter than ${MIN_PASSPHRASE} characters.`)
    return given
  }
  if (!interactive()) throw needPassphrase('An encrypted export')
  for (;;) {
    const first = await readSecret('  Passphrase to encrypt this bundle with: ')
    if (first.length < MIN_PASSPHRASE) {
      process.stderr.write(`  At least ${MIN_PASSPHRASE} characters, please.\n`)
      continue
    }
    if ((await readSecret('  Again, to confirm: ')) === first) return first
    process.stderr.write('  They did not match.\n')
  }
}
