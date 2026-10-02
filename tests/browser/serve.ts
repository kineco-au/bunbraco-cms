/**
 * Boots bunbraco for the browser suite on a throwaway copy of apps/site: its
 * schema and views, a fresh SQLite file, a known admin password.
 */
import { appendFileSync, cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DEFAULT_DATA_TYPES } from '@bunbraco/data'
import { createServer, loadConfig } from '@bunbraco/server'
import { BLOCK_ONLY_ELEMENT_TYPE, BROWSER_ADMIN } from './fixtures.ts'

const repo = join(import.meta.dir, '../..')
mkdirSync(join(repo, 'output'), { recursive: true })
const root = mkdtempSync(join(repo, 'output', 'browser-site-'))
cpSync(join(repo, 'apps/site/schema'), join(root, 'schema'), { recursive: true })
cpSync(join(repo, 'apps/site/Views'), join(root, 'Views'), { recursive: true })

// A document type with a property for every built-in data type, for the
// editor-coverage tests, and a view that renders a crop of its image picker.
const editors = DEFAULT_DATA_TYPES.filter((d) => d.editorAlias !== 'Umbraco.ListView')
writeFileSync(
  join(root, 'schema', 'document-types', 'every-editor.toml'),
  `[document-type]\nalias = "everyEditor"\nname = "Every editor"\nallow-at-root = true\ntemplates = ["everyEditor"]\ndefault-template = "everyEditor"\n${editors
    .map((d) => `\n[[property]]\nalias = "${d.alias}"\nname = "${d.name}"\ntype = "${d.alias}"\n`)
    .join('')}`,
)
writeFileSync(
  join(root, 'Views', 'everyEditor.tsx'),
  `export default function EveryEditor({ model }) {
  const hero = model.value('imageMediaPicker')
  return <main><h1>{model.name}</h1><img class="hero" src={hero?.cropUrl({ width: 40, height: 40 })} /></main>
}
`,
)

// A page that varies by culture, for the two-language tests
writeFileSync(
  join(root, 'schema', 'document-types', 'variant-page.toml'),
  `[document-type]
alias = "variantPage"
name = "Variant page"
allow-at-root = true
templates = ["variantPage"]
default-template = "variantPage"
varies-by-culture = true

[[property]]
alias = "title"
name = "Title"
type = "textstring"
varies-by-culture = true
`,
)
writeFileSync(
  join(root, 'Views', 'variantPage.tsx'),
  `export default function VariantPage({ model, culture }) {
  return <main><h1>{model.name}</h1><p class="title">{model.text('title', { fallback: 'language' })}</p><i>{culture}</i></main>
}
`,
)

// An element type that is not allowed in the Library, for the workspace hint.
// Written here rather than borrowed from the site: the backoffice rewrites the
// site's own schema whenever someone flips that toggle, and did — the type this
// test used to lean on has carried `allow-in-library` since it was committed.
writeFileSync(
  join(root, 'schema', 'document-types', 'block-only.toml'),
  `[document-type]
key = "${BLOCK_ONLY_ELEMENT_TYPE}"
alias = "blockOnly"
name = "Block only"
is-element = true

[[property]]
alias = "text"
name = "Text"
type = "textstring"
`,
)

// Links the site "e-mails", for the invitation and password-reset tests to follow
const LINKS = join(repo, 'output', 'browser-links.jsonl')
writeFileSync(LINKS, '')

const port = Number(Bun.env.BUNBRACO_BROWSER_PORT ?? 3210)
const server = await createServer(
  loadConfig(
    {
      port,
      sqliteFile: join(root, 'site.sqlite'),
      schemaDir: join(root, 'schema'),
      viewsDir: join(root, 'Views'),
      mediaDir: join(root, 'media'),
      adminLogin: BROWSER_ADMIN.login,
      adminPassword: BROWSER_ADMIN.password,
      development: true,
      allowPasswordReset: true,
      sendUserLink: async (message) => {
        appendFileSync(
          LINKS,
          `${JSON.stringify({ email: message.to.email, kind: message.kind, link: message.link })}\n`,
        )
      },
    },
    root,
  ),
)
Bun.serve(server.serveOptions)
console.log(`browser suite server on http://localhost:${port} (site ${root})`)

const stop = async () => {
  await server.close()
  rmSync(root, { recursive: true, force: true })
  process.exit(0)
}
process.on('SIGTERM', stop)
process.on('SIGINT', stop)
