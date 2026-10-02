/**
 * The assistant's boundary, asserted against the contract rather than trusted.
 *
 * The feature's security story is that the tool surface is too small to do harm:
 * reads only, plus proposals that a person applies. These tests are what makes
 * that a property of the repository instead of a claim in a document — widening
 * an allowlist without meaning to fails here.
 */
import { describe, expect, test } from 'bun:test'
import {
  APPLY_OPERATIONS,
  CHANGE_KINDS,
  isForbidden,
  isReadable,
  NON_MUTATING_WRITES,
  READABLE_AREAS,
  readableOperations,
  SCHEMA_KINDS,
  scanTemplateSource,
} from '@bunbraco/assistant'
import { listOperations, loadSpec, type OperationInfo } from '@bunbraco/contracts'

const operations = listOperations(loadSpec())
const byId = new Map(operations.map((operation) => [operation.operationId, operation]))
const readable = readableOperations(operations)

/** Everything a reviewer would expect to be impossible, by name rather than by rule. */
const MUST_BE_UNREACHABLE = [
  'PutDocumentByIdPublish',
  'PutDocumentByIdUnpublish',
  'PutDocumentByIdPublishWithDescendants',
  'PostDocumentCreateAndPublish',
  'PutDocumentByIdUpdateAndPublish',
  'DeleteDocumentById',
  'DeleteDocumentTypeById',
  'DeleteDataTypeById',
  'DeleteTemplateById',
  'PutDocumentByIdMoveToRecycleBin',
  'PutDocumentByIdMove',
  'PostDocumentByIdCopy',
  'PutDocumentSort',
  'PutDocumentByIdPublicAccess',
  'PutDocumentByIdDomains',
  'PostUser',
  'PostUserGroup',
  'DeleteUserById',
  'PostMember',
  'PostSecurityForgotPassword',
  'DeleteRecycleBinDocument',
  'PostDocumentTypeImport',
] as const

describe('what the assistant can reach', () => {
  test('every operation it may read is a GET, or a write listed as non-mutating', () => {
    const unexpected = readable
      .filter((operation) => operation.method !== 'get')
      .filter((operation) => !NON_MUTATING_WRITES.has(operation.operationId))
    expect(unexpected.map((operation) => operation.operationId)).toEqual([])
  })

  test('nothing that publishes, deletes, moves or copies is reachable', () => {
    for (const operationId of MUST_BE_UNREACHABLE) {
      const operation = byId.get(operationId)
      // A renamed operation must fail loudly, not silently stop being checked.
      expect(operation, `${operationId} is no longer in the contract`).toBeDefined()
      expect(isReadable(operation as OperationInfo), `${operationId} is readable`).toBe(false)
      expect(Object.values(APPLY_OPERATIONS)).not.toContain(operationId)
    }
  })

  test('no operation with publish in its path is readable', () => {
    const publishing = operations.filter((operation) => operation.path.includes('publish'))
    expect(publishing.length).toBeGreaterThan(0)
    expect(publishing.filter(isReadable)).toEqual([])
  })

  test('users, members and security are outside the readable areas', () => {
    for (const area of [
      'user',
      'user-group',
      'user-data',
      'member',
      'member-group',
      'member-type',
      'security',
      'install',
      'upgrade',
      'package',
      'webhook',
    ]) {
      expect(READABLE_AREAS.has(area), `${area} is readable`).toBe(false)
    }
  })

  test('every readable operation is in an allowed area', () => {
    for (const operation of readable) {
      expect(READABLE_AREAS.has(operation.area ?? '')).toBe(true)
    }
  })

  test('it can still read the things it needs to do its job', () => {
    const ids = new Set(readable.map((operation) => operation.operationId))
    for (const needed of [
      'GetDocumentById',
      'GetDocumentTypeById',
      'GetDataTypeById',
      'GetTemplateById',
      'GetTreeDocumentRoot',
      'GetDocumentTypeByIdAllowedChildren',
      'PostDocumentValidate',
    ]) {
      expect(ids.has(needed), `${needed} is not readable`).toBe(true)
    }
  })

  test('every non-mutating write is a real operation that is not a GET', () => {
    for (const operationId of NON_MUTATING_WRITES) {
      const operation = byId.get(operationId)
      expect(operation, `${operationId} is not in the contract`).toBeDefined()
      expect((operation as OperationInfo).method).not.toBe('get')
      expect(isForbidden(operation as OperationInfo)).toBe(false)
      // Each one must be a validation or lookup endpoint; nothing else qualifies.
      expect((operation as OperationInfo).path).toMatch(/validate|available-compositions/)
    }
  })
})

describe('what an approval can apply', () => {
  test('every dispatched kind maps to an operation that exists and is allowed', () => {
    for (const kind of CHANGE_KINDS) {
      const operationId = APPLY_OPERATIONS[kind]
      // Schema kinds write a TOML file and import it; they dispatch nothing.
      if (SCHEMA_KINDS.has(kind)) {
        expect(operationId).toBeUndefined()
        continue
      }
      const operation = byId.get(operationId as string)
      expect(operation, `${operationId} is not in the contract`).toBeDefined()
      expect(isForbidden(operation as OperationInfo)).toBe(false)
      expect((operation as OperationInfo).path).not.toContain('publish')
    }
  })

  test('every kind is either dispatched or written as schema, never neither', () => {
    for (const kind of CHANGE_KINDS) {
      const dispatched = APPLY_OPERATIONS[kind] !== undefined
      expect(dispatched !== SCHEMA_KINDS.has(kind), `${kind} has no way to apply`).toBe(true)
    }
  })

  test('creating a document uses the operation that leaves it unpublished', () => {
    expect(APPLY_OPERATIONS['document-create']).toBe('PostDocument')
    expect(Object.values(APPLY_OPERATIONS)).not.toContain('PostDocumentCreateAndPublish')
    expect(Object.values(APPLY_OPERATIONS)).not.toContain('PutDocumentByIdUpdateAndPublish')
  })
})

describe('proposed template source', () => {
  const clean = `import type { PageProps } from 'bunbraco'
export default function Page({ model }: PageProps) {
  return <h1>{model.text('title')}</h1>
}
`

  test('accepts a template that only uses the model', () => {
    expect(scanTemplateSource('page.tsx', clean)).toEqual([])
  })

  test('refuses a shell, whether it is imported or reached through the global', () => {
    expect(scanTemplateSource('page.tsx', `import { $ } from 'bun'\nawait $\`ls\`\n`)).toEqual([
      {
        file: 'page.tsx',
        path: 'imports',
        message: 'bun is not an allowed import; use bunbraco or a file beside this one',
      },
    ])
    expect(scanTemplateSource('page.tsx', 'await Bun.$`ls`\n')).toEqual([
      { file: 'page.tsx', path: 'source', message: 'Bun is not allowed in a proposed template' },
    ])
  })

  test('catches a forbidden global inside a template substitution', () => {
    // Written as a template literal so the `${…}` under test is not read as one here.
    const source = `export const x = \`key=\${process.env.TOKEN}\`\n`
    const problems = scanTemplateSource('page.tsx', source)
    expect(problems.map((problem) => problem.message)).toEqual([
      'process is not allowed in a proposed template',
    ])
  })

  test('page text that happens to read like code is left alone', () => {
    const source = `import type { PageProps } from 'bunbraco'
export default ({ model }: PageProps) => (
  <p>Our process is to fetch the Bun and eval the require</p>
)
`
    expect(scanTemplateSource('page.tsx', source)).toEqual([])
  })

  test('refuses node builtins, process, eval and fetch', () => {
    for (const source of [
      `import { readFileSync } from 'node:fs'\nreadFileSync('x')\n`,
      'export const secret = process.env.TOKEN\n',
      'export const x = eval("1")\n',
      'export const x = await fetch("https://example.com")\n',
      'export const f = new Function("return 1")\n',
    ]) {
      expect(scanTemplateSource('page.tsx', source).length).toBeGreaterThan(0)
    }
  })

  test('refuses the ways to eval that are not spelled eval', () => {
    // Each of these reached the Function constructor or the environment while
    // scanning clean, which mattered because the problems list is what stops a
    // proposal being approvable.
    const sources: Record<string, string> = {
      'called, not constructed': 'export const x = Function("return process.env")()\n',
      'through any function': 'export const x = (() => {}).constructor("return 1")()\n',
      'commonjs under Bun': `const cp = import.meta.require('node:child_process')\nexport default () => cp\n`,
      'the environment by another name': 'export const x = import.meta.env.AWS_SECRET_ACCESS_KEY\n',
      // Literals are stripped before the identifier scan, so this form is
      // matched on the source before that happens.
      'by name in a bracket': 'export const f = (() => {})["constructor"]\n',
    }
    for (const [what, source] of Object.entries(sources)) {
      expect(scanTemplateSource('page.tsx', source).length, what).toBeGreaterThan(0)
    }
  })

  test('refuses an import that climbs out of the views directory', () => {
    const problems = scanTemplateSource(
      'page.tsx',
      `import x from '../../packages/data/src/index.ts'\nexport default () => x\n`,
    )
    expect(problems[0]?.message).toContain('leaves the views directory')
  })

  test('refuses a dynamic import', () => {
    const problems = scanTemplateSource(
      'page.tsx',
      'export default async () => (await import("bun")).$\n',
    )
    expect(problems.map((problem) => problem.message)).toContain(
      'dynamic import() is not allowed in a proposed template',
    )
  })

  test('allows a sibling partial and the bunbraco entry point', () => {
    const source = `import { Html } from 'bunbraco'\nimport Card from './card.tsx'\nexport default () => <Html><Card /></Html>\n`
    expect(scanTemplateSource('page.tsx', source)).toEqual([])
  })

  test('a property called fetch is not mistaken for the global', () => {
    const source = `import type { PageProps } from 'bunbraco'\nexport default ({ model }: PageProps) => <p>{model.text('fetch')}</p>\n`
    expect(scanTemplateSource('page.tsx', source)).toEqual([])
  })

  test('reports source that will not compile', () => {
    const problems = scanTemplateSource('page.tsx', 'export default function ( {\n')
    expect(problems[0]?.message).toContain('will not compile')
  })
})
