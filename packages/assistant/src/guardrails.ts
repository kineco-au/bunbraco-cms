/**
 * Static checks on TSX the assistant proposes.
 *
 * A template is an ES module the renderer imports, so `Bun.$` in one is a shell
 * and `fetch` in one is an exfiltration channel. A person editing templates in
 * the backoffice may write both; the assistant may not, which is the point.
 *
 * Defence in depth behind human approval, not a sandbox — do not describe it as
 * one. Source is transpiled before the identifier scan so that a type annotation
 * or JSX cannot hide code, the same approach as scripts/check-module-graph.ts.
 */
import type { SchemaProblem } from '@bunbraco/schema'

/** Module specifiers a proposed template may import from. */
const ALLOWED_BARE_IMPORTS: ReadonlySet<string> = new Set(['bunbraco'])

/**
 * Globals a proposed template may not name. `fetch` is here deliberately: a
 * template that calls out at render time is a legitimate thing for a person to
 * write and not something to accept from a model.
 */
const FORBIDDEN_GLOBALS = [
  'Bun',
  'process',
  'eval',
  'require',
  'fetch',
  'globalThis',
  'XMLHttpRequest',
  'WebAssembly',
  // Called rather than constructed, `Function('return process.env')()` is `eval`
  // by another name; listing the identifier covers both spellings.
  'Function',
] as const

/** Not preceded by a dot, so `model.fetch(...)` is a property and not the global. */
const forbiddenGlobal = new RegExp(`(?<![.\\w$])(?:${FORBIDDEN_GLOBALS.join('|')})\\b`, 'g')

/**
 * `import.meta` is a global in all but name, and not one the identifier scan can
 * see: under Bun `import.meta.require` is a working CommonJS require — so
 * `node:child_process` — and `import.meta.env` aliases the environment.
 */
const importMeta = /(?<![.\w$])import\s*\.\s*meta\b/

/**
 * Every function's `constructor` is the Function constructor, so the property
 * access this scan allows on purpose — `model.value` must keep working — is also
 * a road to `eval`: `(() => {}).constructor('…')()`.
 */
const constructorAccess = /\.\s*constructor\b/

/**
 * The same names reached as `obj['fetch']`. Stripping string literals is what
 * stops a page's own words being read as code, and it would hide this, so it is
 * matched on the source before that: a bracket holding one of these exact names
 * is not something a template does by accident.
 */
const bracketedName = new RegExp(
  `\\[\\s*(['"])(?:${[...FORBIDDEN_GLOBALS, 'constructor'].join('|')})\\1\\s*\\]`,
)

const transpiler = new Bun.Transpiler({ loader: 'tsx' })

/**
 * Code with the text of strings, template literals and comments removed, so that
 * a page's own words cannot be read as identifiers — `model.text('fetch')` is a
 * property name, not a call to the global.
 *
 * Substitutions inside a template literal are kept, because `${process.env.KEY}`
 * is code. Anything this cannot parse cleanly is left in place to be scanned,
 * which risks a false positive and never a miss.
 */
function stripLiterals(code: string): string {
  let out = ''
  let i = 0
  while (i < code.length) {
    const c = code[i] as string
    const next = code[i + 1]

    if (c === '/' && next === '/') {
      while (i < code.length && code[i] !== '\n') i++
      continue
    }
    if (c === '/' && next === '*') {
      i += 2
      while (i < code.length && !(code[i] === '*' && code[i + 1] === '/')) i++
      i += 2
      continue
    }
    if (c === "'" || c === '"') {
      i++
      while (i < code.length && code[i] !== c) {
        if (code[i] === '\\') i++
        i++
      }
      i++
      out += '""'
      continue
    }
    if (c === '`') {
      i++
      out += '``'
      while (i < code.length) {
        const ch = code[i] as string
        if (ch === '\\') {
          i += 2
          continue
        }
        if (ch === '`') {
          i++
          break
        }
        if (ch === '$' && code[i + 1] === '{') {
          i += 2
          const start = i
          let depth = 1
          while (i < code.length && depth > 0) {
            if (code[i] === '{') depth++
            else if (code[i] === '}') depth--
            if (depth > 0) i++
          }
          out += ` ${stripLiterals(code.slice(start, i))} `
          i++
          continue
        }
        i++
      }
      continue
    }
    out += c
    i++
  }
  return out
}

/**
 * Problems with proposed template source, empty when there are none. `file` is
 * the template's path so the message reads the same as a schema problem.
 */
export function scanTemplateSource(file: string, source: string): SchemaProblem[] {
  const problems: SchemaProblem[] = []
  const at = (path: string, message: string) => problems.push({ file, path, message })

  let transpiled: string
  try {
    transpiled = transpiler.transformSync(source)
  } catch (error) {
    at('source', `will not compile: ${(error as Error).message.split('\n')[0]}`)
    return problems
  }
  const code = stripLiterals(transpiled)

  for (const entry of transpiler.scan(source).imports) {
    if (entry.kind === 'dynamic-import') {
      at('imports', 'dynamic import() is not allowed in a proposed template')
      continue
    }
    const specifier = entry.path
    if (specifier.startsWith('./')) {
      if (specifier.includes('..')) at('imports', `${specifier} leaves the views directory`)
      continue
    }
    if (specifier.startsWith('../')) {
      at('imports', `${specifier} leaves the views directory`)
      continue
    }
    if (!ALLOWED_BARE_IMPORTS.has(specifier)) {
      at('imports', `${specifier} is not an allowed import; use bunbraco or a file beside this one`)
    }
  }

  const named = new Set<string>()
  for (const match of code.matchAll(forbiddenGlobal)) named.add(match[0])
  for (const name of [...named].sort())
    at('source', `${name} is not allowed in a proposed template`)
  if (importMeta.test(code)) at('source', 'import.meta is not allowed in a proposed template')
  if (constructorAccess.test(code))
    at('source', 'constructor is not allowed in a proposed template')
  if (bracketedName.test(transpiled))
    at('source', 'reaching a global by name is not allowed in a proposed template')

  return problems
}
