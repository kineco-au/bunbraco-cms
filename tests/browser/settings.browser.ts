/**
 * The Settings section's document type editor, against the real backoffice.
 */
import type { Page } from '@playwright/test'
import { expect, signIn, test } from './fixtures.ts'

const HOME_PAGE_TYPE = 'bf568bcf-9e04-4ef2-ba37-e582717178e3'

interface EditorState {
  uri: string
  language: string
  /** Errors only. A hint or a suggestion is not what an editor "shows errors" means. */
  errors: string[]
}

/**
 * What monaco makes of the open view: its model, and what it underlines.
 *
 * Reached through the locator rather than `document.querySelector`, which does
 * not cross a shadow root — the code editor sits inside several. monaco itself
 * comes from the bare specifier, so the page's own import map resolves it to the
 * very module the editor loaded, hash in the path and all.
 */
async function openView(page: Page): Promise<EditorState> {
  return await page.locator('umb-code-editor').evaluate(async (host) => {
    const element = host as unknown as {
      editor?: { monacoEditor?: { getModel(): { uri: object; getLanguageId(): string } | null } }
    }
    const model = element.editor?.monacoEditor?.getModel()
    // Reported as a fault rather than an empty answer, so that "nothing is
    // underlined" cannot be satisfied by having found nothing to look at.
    if (!model) return { uri: 'none', language: 'none', errors: ['the editor has no model'] }
    const specifier = '@umbraco-cms/backoffice/external/monaco-editor'
    const { monaco } = (await import(specifier)) as {
      monaco: {
        editor: {
          getModelMarkers(filter: { resource: object }): { message: string; severity: number }[]
        }
      }
    }
    return {
      uri: String(model.uri),
      language: model.getLanguageId(),
      errors: monaco.editor
        .getModelMarkers({ resource: model.uri })
        .filter((marker) => marker.severity === 8)
        .map((marker) => marker.message),
    }
  })
}

test('a template added to a document type is still shown after save', async ({ page }) => {
  // Its own template, so a rerun against the same site adds something new
  const alias = `extra${Math.random().toString(36).slice(2, 7)}`
  await signIn(page)
  const created = await page.request.post('/umbraco/management/api/v1/template', {
    data: { name: alias, alias, content: 'export default function X() { return <p /> }\n' },
  })
  expect(created.status()).toBe(201)
  await page.goto(
    `/bunbraco/section/settings/workspace/document-type/edit/${HOME_PAGE_TYPE}/view/templates`,
  )
  await page.getByRole('button', { name: 'Choose' }).first().click()
  const picker = page.locator('umb-template-picker-modal, umb-tree-picker-modal')
  await picker.getByText(alias, { exact: true }).click()
  await picker.getByRole('button', { name: 'Choose' }).click()
  // The workspace's own chip for the template. Not `getByText(alias)`: the
  // Templating tree in the sidebar lists the new template as well, so that
  // matches twice and strict mode refuses it.
  const chip = page.getByRole('button', { name: `Open ${alias}` })
  await expect(chip).toBeVisible()

  await page.getByRole('button', { name: 'Save' }).click()
  await expect(page.getByText('Document Type saved').first()).toBeVisible()
  // The editor re-reads the saved type; the server's change event must have
  // dropped the client's cached copy, or it redraws the old one
  await expect(chip).toBeVisible()
  await expect(page.getByText('homePage', { exact: true }).first()).toBeVisible()
})

test('a new template starts as a TSX view, and its master template is written as a layout export', async ({
  page,
}) => {
  const NAME = `Landing ${Math.random().toString(36).slice(2, 7)}`
  await signIn(page)
  await page.goto('/bunbraco/section/settings/workspace/template/create/parent/template-root/null')
  const editor = page.locator('umb-code-editor')
  await expect(editor).toContainText('export default function Template({ model }: PageProps)')
  await expect(editor).not.toContainText('@inherits')

  // A master template: the view gains `export const layout`, not a Razor block
  await page.locator('#layout-template-button').click()
  const picker = page.locator('uui-modal-sidebar').last()
  await picker.getByText('contentPage', { exact: true }).click()
  await picker.getByRole('button', { name: 'Choose' }).click()
  await expect(editor).toContainText("export const layout = 'contentPage'")
  await expect(editor).not.toContainText('Layout =')

  const name = page.getByRole('textbox', { name: 'Enter a name...' })
  // Typed within moments of the master changing, a re-render can clear it
  await expect(async () => {
    await name.fill(NAME)
    await name.press('Tab')
    await expect(name).toHaveValue(NAME, { timeout: 500 })
  }).toPass({ timeout: 10_000 })
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(page).toHaveURL(/\/workspace\/template\/edit\//)
  const key = /\/edit\/([0-9a-f-]{36})/.exec(page.url())?.[1] as string
  const saved = (await (
    await page.request.get(`/umbraco/management/api/v1/template/${key}`)
  ).json()) as { content: string; masterTemplate: { id: string } | null }
  expect(saved.content).toContain(
    "import type { PageProps } from 'bunbraco'\n\nexport const layout = 'contentPage'\n\n",
  )
  expect(saved.content).not.toContain('@')
  expect(saved.masterTemplate).toEqual({ id: expect.any(String) })

  // Reopened, the editor shows the master the view names
  await page.reload()
  await expect(page.locator('#layout-template-button')).toHaveAttribute(
    'label',
    'Layout template: contentPage',
  )
  // Removing the master takes the export away again
  await page.getByRole('button', { name: 'Remove' }).click()
  await expect(editor).not.toContainText('export const layout')
})

test('the view editor reads TSX, and checks it against the site’s own types', async ({ page }) => {
  await signIn(page)
  await page.goto('/bunbraco/section/settings/workspace/template/create/parent/template-root/null')
  const editor = page.locator('umb-code-editor')
  await expect(editor).toContainText('export default function Template({ model }: PageProps)')

  // The dialect is monaco's TypeScript service on a file named as what it is:
  // TypeScript reads JSX only in a `.tsx` file, and the model monaco makes for
  // itself is `inmemory://model/1`.
  await expect(async () => {
    const view = await openView(page)
    expect(view.language).toBe('typescript')
    expect(view.uri).toMatch(/^file:\/\/\/Views\/.+\.tsx$/)
  }).toPass({ timeout: 15_000 })

  // Nothing is underlined in the scaffold. Every tag in it, and the `bunbraco`
  // import above it, is what an editor configured for Razor complained about.
  await expect(async () => expect((await openView(page)).errors).toEqual([])).toPass({
    timeout: 20_000,
  })

  // And the types are the site's own, not a guess: a property `PublishedContent`
  // does not have can only be an error if `bunbraco` resolved to the module the
  // server served.
  await editor.evaluate((host) => {
    ;(host as unknown as { code: string }).code = `import type { PageProps } from 'bunbraco'

export default function Template({ model }: PageProps) {
  return <h1>{model.nosuchthing()}</h1>
}
`
  })
  await expect(async () =>
    expect((await openView(page)).errors.join('\n')).toContain('nosuchthing'),
  ).toPass({ timeout: 20_000 })
})

test('a new partial view starts from a TSX skeleton; a stylesheet and a script save as files', async ({
  page,
}) => {
  const id = Math.random().toString(36).slice(2, 7)
  const api = async <T>(path: string) =>
    (await (await page.request.get(`/umbraco/management/api/v1${path}`)).json()) as T
  await signIn(page)

  const save = async (name: string) => {
    const field = page.getByRole('textbox', { name: 'Enter a name...' })
    // The name commits on change, which fires when the field is left
    await expect(async () => {
      await field.fill(name)
      await field.press('Tab')
      await expect(field).toHaveValue(name, { timeout: 500 })
    }).toPass({ timeout: 10_000 })
    await page.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(page).toHaveURL(/\/edit\//)
  }

  // Partial view: the editor opens on the Empty snippet, not a blank page
  await page.goto(
    '/bunbraco/section/settings/workspace/partial-view/create/parent/partial-view-root/null',
  )
  const editor = page.locator('umb-code-editor')
  await expect(editor).toContainText("import type { PageProps } from 'bunbraco'")
  await expect(editor).toContainText('export default function Partial')
  await save(`nav${id}`)
  const partial = await api<{ name: string; content: string }>(
    `/partial-view/${encodeURIComponent(`/nav${id}.tsx`)}`,
  )
  expect(partial.name).toBe(`nav${id}.tsx`)
  expect(partial.content).toContain('export default function Partial')

  // Stylesheet and script: saved under their own folders, served on the site
  await page.goto(
    '/bunbraco/section/settings/workspace/stylesheet/create/parent/stylesheet-root/null',
  )
  await expect(editor).toBeVisible()
  await save(`site${id}`)
  expect((await page.request.get(`/css/site${id}.css`)).status()).toBe(200)

  await page.goto('/bunbraco/section/settings/workspace/script/create/parent/script-root/null')
  await expect(editor).toBeVisible()
  await save(`site${id}`)
  expect((await page.request.get(`/scripts/site${id}.js`)).status()).toBe(200)
})

test('the log viewer shows the overview and searches the log, with no error', async ({ page }) => {
  await signIn(page)
  // The overview: level counts, the common messages and the saved searches
  await page.goto('/bunbraco/section/settings/workspace/logviewer/view/overview')
  await expect(page.getByText('Find all logs that has an exception property').first()).toBeVisible()
  await expect(page.getByText(/Bunbraco .* started on node/).first()).toBeVisible()
  // The search: the log itself, filtered by an expression.
  //
  // `StartsWith` rather than `=`. The template gained ` as {role}` and this
  // search went on naming the old string, so it matched nothing — while the
  // looser overview assertion above still passed, which is why it went unnoticed.
  // Matching the stable prefix means the next property added to that log line
  // does not break the test either.
  await page.goto(
    `/bunbraco/section/settings/workspace/logviewer/view/search?lq=${encodeURIComponent("StartsWith(@MessageTemplate, 'Bunbraco {version} started on node')")}`,
  )
  // The version is not asserted: the point is that the search renders the event
  // with its properties, and a literal here breaks on every release. Importing
  // VERSION is not an option either — Playwright's CLI runs under Node, which
  // cannot load the `bun:` modules @bunbraco/server pulls in.
  await expect(page.getByText(/Bunbraco "[^"]+" started on node/).first()).toBeVisible()
})

/**
 * One tree over `components/`, in place of Umbraco's Templates and Partial
 * Views.
 *
 * The split exists in Umbraco because Razor needed a master-template concept; a
 * TSX layout is an import, so here the only thing that makes a component a
 * template is that a document type names it. The tree that survived is the
 * partial-view one, because it is path-addressed and understands folders — the
 * template tree is id-addressed and cannot show one.
 */
test('the Settings tree offers Components, and neither tree it replaced', async ({ page }) => {
  await signIn(page)
  await page.goto('/bunbraco/section/settings')

  // The sidebar groups it under Templating, beside Stylesheets and Scripts.
  await expect(page.getByText('Components', { exact: true }).first()).toBeVisible()
  // Both vendored menu items are overwritten, so neither name is left to click.
  await expect(page.getByText('Templates', { exact: true })).toHaveCount(0)
  await expect(page.getByText('Partial Views', { exact: true })).toHaveCount(0)
})

test('a component and a folder can both be created from the Components tree', async ({ page }) => {
  const id = Math.random().toString(36).slice(2, 7)
  await signIn(page)

  // A folder, then a component inside it: the point of one root with folders is
  // that a site can arrange its own components, which the flat template tree
  // could not express at all.
  const folder = await page.request.post('/umbraco/management/api/v1/partial-view/folder', {
    data: { name: `grp${id}`, parent: null },
  })
  expect(folder.status()).toBe(201)

  const component = await page.request.post('/umbraco/management/api/v1/partial-view', {
    data: {
      name: `card${id}.tsx`,
      content: 'export function Card() {\n  return <p />\n}\n',
      parent: { path: `/grp${id}` },
    },
  })
  expect(component.status()).toBe(201)

  // And the tree shows the folder it was put in.
  await page.goto('/bunbraco/section/settings')
  await page.getByText('Components', { exact: true }).first().click()
  await expect(page.getByText(`grp${id}`, { exact: true })).toBeVisible()
})
