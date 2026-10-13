/**
 * Context in page templates: the page from any component, a template's own
 * values handed down without props, and ids unique to the render.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ComponentRepository, ContentTypeRepository } from '@bunbraco/data'
import {
  createContext,
  type PageProps,
  renderScope,
  useContext,
  useId,
  usePage,
} from '@bunbraco/render'
import { type Child, renderToString } from '@bunbraco/render/jsx-runtime'
import { type Harness, ORIGIN, signedInServer, V1 } from './support/harness.ts'

const later = <T,>(value: T, ms = 2): Promise<T> =>
  new Promise((resolve) => setTimeout(() => resolve(value), ms))

/** Enough of a page for the components here, which read only its culture. */
const page = (culture: string) => ({ culture }) as unknown as PageProps

const render = (props: PageProps, view: () => Child) =>
  renderScope(props, () => renderToString(view()))

describe('usePage()', () => {
  test('reaches a component however deep, with no props passed down, across an await', async () => {
    const Deep = async () => {
      await later(null)
      return <em>{usePage().culture}</em>
    }
    const Middle = () => (
      <p>
        <Deep />
      </p>
    )
    expect(await render(page('en-AU'), () => <Middle />)).toBe('<p><em>en-AU</em></p>')
  })

  test('keeps two renders apart, though they interleave', async () => {
    const Slow = async ({ ms }: { ms: number }) => {
      await later(null, ms)
      return usePage().culture
    }
    const [first, second] = await Promise.all([
      render(page('fr-FR'), () => <Slow ms={20} />),
      render(page('de-DE'), () => <Slow ms={1} />),
    ])
    expect([first, second]).toEqual(['fr-FR', 'de-DE'])
  })

  test('outside a render, says where it can be called', () => {
    expect(() => usePage()).toThrow('can only be called while a page is rendering')
  })
})

describe('createContext and useContext', () => {
  const Theme = createContext('light')
  const Swatch = () => <span>{useContext(Theme)}</span>

  test('without a provider, the default', async () => {
    expect(await render(page('en'), () => <Swatch />)).toBe('<span>light</span>')
    expect(useContext(Theme)).toBe('light')
  })

  test('a provider hands its value to the children it renders, and a nearer one wins', async () => {
    expect(
      await render(page('en'), () => (
        <div>
          <Theme.Provider value="dark">
            {() => (
              <>
                <Swatch />
                <Theme value="sepia">{() => <Swatch />}</Theme>
                <Swatch />
              </>
            )}
          </Theme.Provider>
          <Swatch />
        </div>
      )),
    ).toBe('<div><span>dark</span><span>sepia</span><span>dark</span><span>light</span></div>')
  })

  test('the value reaches async children', async () => {
    const Late = async () => {
      await later(null)
      return <Swatch />
    }
    expect(
      await render(page('en'), () => (
        <Theme.Provider value="dark">{() => <Late />}</Theme.Provider>
      )),
    ).toBe('<span>dark</span>')
  })

  test('plain children are refused, because they rendered before the provider ran', () => {
    expect(() =>
      // @ts-expect-error Plain children are a type error too.
      renderScope(page('en'), () => <Theme.Provider value="dark">{<Swatch />}</Theme.Provider>),
    ).toThrow('A context Provider takes its children as a function')
  })
})

describe('useId()', () => {
  test('is unique within a render, through providers, and starts again for the next', async () => {
    const Theme = createContext('light')
    const Field = ({ label }: { label: string }) => {
      const id = useId()
      return (
        <>
          <label for={id}>{label}</label>
          <input id={id} />
        </>
      )
    }
    const view = () => (
      <form>
        <Field label="Name" />
        <Theme.Provider value="dark">{() => <Field label="Email" />}</Theme.Provider>
      </form>
    )
    const first = await render(page('en'), view)
    expect(first).toBe(
      '<form><label for=":b0:">Name</label><input id=":b0:" /><label for=":b1:">Email</label><input id=":b1:" /></form>',
    )
    expect(await render(page('en'), view)).toBe(first)
  })

  test('outside a render, says where it can be called', () => {
    expect(() => useId()).toThrow('can only be called while a page is rendering')
  })
})

describe('a page rendered by the server', () => {
  const open: Harness[] = []
  const dirs: string[] = []
  afterEach(async () => {
    while (open.length > 0)
      await open
        .pop()
        ?.db.close()
        .catch(() => {})
    while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true })
  })

  test('lets a nested component and the layout read the page', async () => {
    const root = mkdtempSync(join(process.cwd(), 'output', 'context-'))
    dirs.push(root)
    for (const dir of ['schema/content-types', 'components/shared'])
      mkdirSync(join(root, dir), { recursive: true })
    writeFileSync(join(root, 'schema', 'schema.toml'), '[schema]\nversion = "1.0.0"\n')
    writeFileSync(
      join(root, 'schema', 'content-types', 'home.toml'),
      `[content-type]
alias = "homePage"
name = "Home page"
allow-at-root = true
components = ["homePage"]
default-component = "homePage"

[[property]]
alias = "heading"
name = "Heading"
type = "textstring"
`,
    )
    writeFileSync(
      join(root, 'components', 'homePage.tsx'),
      `import { usePage } from 'bunbraco'
export const layout = 'shared/layout'
function Heading() {
  return <h1>{usePage().model.text('heading')}</h1>
}
export default function Home() {
  return <Heading />
}
`,
    )
    writeFileSync(
      join(root, 'components', 'shared', 'layout.tsx'),
      `import { usePage } from 'bunbraco'
export default function Layout({ children }) {
  return <main data-page={usePage().model.name}>{children}</main>
}
`,
    )
    const h = await signedInServer({
      config: {
        siteDir: root,
        schemaDir: join(root, 'schema'),
        componentsDir: join(root, 'components'),
        componentsCacheDir: join(root, '.bunbraco', 'components'),
        development: true,
        schemaWritable: true,
      },
    })
    open.push(h)
    const typeKey = (await new ContentTypeRepository(h.server.db).byAlias('homePage'))
      ?.key as string
    const componentKey = (await new ComponentRepository(h.server.db).byAlias('homePage'))
      ?.key as string
    const created = await h.post(`${V1}/document`, {
      documentType: { id: typeKey },
      template: { id: componentKey },
      parent: null,
      values: [{ alias: 'heading', culture: null, segment: null, value: 'Hello' }],
      variants: [{ culture: null, segment: null, name: 'Home' }],
    })
    const key = created.headers.get('umb-generated-resource') as string
    expect((await h.put(`${V1}/document/${key}/publish`, { publishSchedules: [] })).status).toBe(
      200,
    )
    const response = await h.server.fetch(new Request(`${ORIGIN}/`))
    expect(await response.text()).toBe('<main data-page="Home"><h1>Hello</h1></main>')
  })
})
