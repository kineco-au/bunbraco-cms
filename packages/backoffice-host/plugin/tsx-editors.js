/**
 * Makes Umbraco's template and partial view editors write and read TSX instead
 * of Razor. Umbraco's client hard-codes a Razor scaffold for a new template,
 * writes a Razor `Layout = "x.cshtml"` block when a master template is chosen,
 * starts a new partial view empty, and opens both in an editor configured for
 * Razor. This entry point changes the methods that do so — the template
 * repository's scaffold, the template workspace's master-template update, the
 * partial view repository's scaffold and the code editor's own language — to
 * write what a bunbraco view is: a default-exported component, with
 * `export const layout = '<alias>'` for its master, and for a partial view the
 * server's `Empty` snippet. Snippets inserted into a view are translated to TSX
 * (`tsx-snippets.js`), and the inserts that have no TSX equivalent — a partial
 * view, which needs an import as well as a tag, and Razor's sections — are hidden.
 *
 * The methods are patched on Umbraco's own classes rather than the extensions
 * re-registered: changing the registry once the backoffice is rendering makes
 * every open section re-evaluate its extensions, and a route set up in that
 * window throws inside Umbraco's code.
 */
import { UmbCodeEditorElement } from '@umbraco-cms/backoffice/code-editor'
import { PartialViewService } from '@umbraco-cms/backoffice/external/backend-api'
import { UmbPartialViewDetailRepository } from '@umbraco-cms/backoffice/partial-view'
import { UmbTemplateDetailRepository } from '@umbraco-cms/backoffice/template'
import { toTsxSnippet } from './tsx-snippets.js'

export const SCAFFOLD = `import type { PageProps } from 'bunbraco'

export default function Template({ model }: PageProps) {
  return (
    <div>
      <h1>{model.name}</h1>
    </div>
  )
}
`

const LAYOUT_EXPORT = /^export\s+const\s+layout\s*=\s*['"][^'"]*['"]\s*;?[ \t]*\n*/m

/**
 * Umbraco's own Razor layout block, the same shape its workspace writes and
 * matches. A TSX view can never legitimately hold one, and the patch below cannot
 * guarantee it is in place before Umbraco's `create()` runs — that method calls
 * `setLayoutTemplate(parent, true)` itself, so on a slow load the unpatched writer
 * can insert a block (with `undefined` for the alias it has not fetched yet)
 * before this module has replaced the method. Stripping it here makes the result
 * the same whichever of the two ran first.
 */
const LAYOUT_BLOCK = /@\{[\s\S]*?Layout\s*=\s*(?:"[^"]*"|null)\s*;[\s\S]*?\}[ \t]*\n*/g

/** `content` with its `export const layout` set to `alias`, or removed when null. */
export function withLayout(content, alias) {
  const rest = content.replace(LAYOUT_BLOCK, '').replace(LAYOUT_EXPORT, '')
  if (!alias) return rest
  const line = `export const layout = '${alias}'\n\n`
  // After the imports, where a view declares it
  const imports = /^(?:import[^\n]*\n)+\n*/.exec(rest)
  if (!imports) return line + rest
  return `${imports[0].replace(/\n*$/, '\n\n')}${line}${rest.slice(imports[0].length)}`
}

/**
 * The dialect a bunbraco view is written in. Accepted on `umb-code-editor`'s
 * `language` in place of one of Umbraco's own, and what Umbraco's hard-coded
 * `razor` is read as.
 *
 * monaco has no `tsx` language of its own, and registering one would be a step
 * backwards: TypeScript decides whether a file may contain JSX from its *file
 * name*, and its worker only attaches to the `typescript` and `javascript`
 * modes. A `tsx` language would therefore tokenise and then be ignored by the
 * service every completion and every real error comes from. So the dialect is
 * monaco's `typescript` mode plus a model whose URI ends in `.tsx`.
 */
export const TSX = 'tsx'

/**
 * The virtual directory a view is opened in. It mirrors `Views/` on disk so that
 * a view's `../schema/content-types.d.ts` resolves in the editor exactly as it
 * resolves for `tsc`.
 */
const VIEWS = 'file:///Views'

/**
 * `bundler` module resolution, which is what the site's tsconfig uses and what
 * resolves the served module. monaco's editor-side `ModuleResolutionKind` names
 * only Classic and NodeJs — the enum predates the option — but the worker's own
 * TypeScript knows it, and monaco passes the compiler options through untouched.
 */
const BUNDLER = 100

/** Code editors showing a view, rather than a stylesheet, a script or JSON. */
const views = new WeakSet()

let opened = 0

function pluginApi() {
  const href = document.querySelector('base')?.getAttribute('href') ?? '/umbraco/'
  return `${href.replace(/\/$/, '')}/bunbraco/api`
}

/** What the server checks a view against, or nothing if it will not say. */
async function typeLibs() {
  try {
    const response = await fetch(`${pluginApi()}/editor-types`, {
      credentials: 'include',
      headers: { accept: 'application/json' },
    })
    if (!response.ok) throw new Error(`the server answered ${response.status}`)
    const body = await response.json()
    return Array.isArray(body?.libs) ? body.libs : []
  } catch (error) {
    // Said out loud, because the consequence is not obvious: with no types,
    // `bunbraco` does not resolve, so there is no `JSX.IntrinsicElements` and
    // TypeScript underlines every tag in the view. Type checking is turned off
    // below rather than left to report that.
    console.error('Bunbraco could not fetch the types for the view editor', error)
    return []
  }
}

let loaded

/**
 * Configures monaco's TypeScript service for TSX, and reports both monaco and
 * whether the dialect is usable.
 *
 * Done on the first view to open rather than at boot, because monaco is several
 * megabytes and most sessions never open one. The types are fetched every time
 * instead of once, so a document type a colleague added is in this editor as
 * soon as the view is reopened; they are small, and the endpoint says
 * `no-store` for the same reason.
 */
async function configureTsx() {
  let monaco
  try {
    loaded ??= import('@umbraco-cms/backoffice/external/monaco-editor')
    monaco = (await loaded).monaco
    // `monaco.typescript`, not `monaco.languages.typescript`: monaco exports each
    // language service as its own top-level namespace, and the nested form is
    // where older versions kept it. Read both, because getting this wrong is what
    // went wrong the first time — and it went wrong quietly.
    const ts = monaco.typescript ?? monaco.languages?.typescript
    if (!ts) throw new Error('monaco exposes no TypeScript service')
    const { JsxEmit, ModuleKind, ScriptTarget, typescriptDefaults } = ts
    // The site's `apps/site/tsconfig.json`, so that what the editor underlines
    // is what `tsc` would report and nothing else.
    typescriptDefaults.setCompilerOptions({
      allowNonTsExtensions: true,
      target: ScriptTarget.ESNext,
      module: ModuleKind.ESNext,
      moduleResolution: BUNDLER,
      jsx: JsxEmit.ReactJSX,
      jsxImportSource: 'bunbraco',
      allowImportingTsExtensions: true,
      noEmit: true,
      strict: true,
    })
    // Replaced wholesale rather than added one at a time, so a refresh cannot
    // leave a stale copy of the generated types behind.
    const libs = await typeLibs()
    typescriptDefaults.setExtraLibs(
      libs.map((lib) => ({ filePath: lib.path, content: lib.content })),
    )
    // Without the types, every name in the view is unresolved and checking it
    // says nothing true. Syntax is still worth checking, and the dialect —
    // highlighting, brackets, JSX that parses — is unaffected either way.
    typescriptDefaults.setDiagnosticsOptions({
      noSemanticValidation: libs.length === 0,
      noSyntaxValidation: false,
    })
    return { monaco, ok: true }
  } catch (error) {
    // Reported rather than swallowed. Configured against the wrong namespace,
    // this failed silently and turned every tag in a view red — and a console
    // error is what the browser suite fails a test on, so the next time this
    // breaks a test says so instead of a person noticing.
    console.error('Bunbraco could not configure the TSX dialect for the view editor', error)
    return { monaco, ok: false }
  }
}

/**
 * Teaches `umb-code-editor` the dialect: `language="tsx"`, and Umbraco's own
 * hard-coded `razor`, become monaco's `typescript` on a `.tsx` model.
 *
 * `language` is a Lit property, so the accessor to wrap is the one Lit defined
 * on the prototype. If a future version of either defines it elsewhere, the
 * editor keeps Umbraco's Razor rather than this entry point throwing on the way
 * in and taking the TSX scaffolds down with it.
 */
function teachDialect(editors) {
  const language = Object.getOwnPropertyDescriptor(editors, 'language')
  if (!language?.set) return
  Object.defineProperty(editors, 'language', {
    ...language,
    set(value) {
      const view = value === TSX || value === 'razor'
      if (view) views.add(this)
      else views.delete(this)
      language.set.call(this, view ? 'typescript' : value)
    },
  })

  const firstUpdated = editors.firstUpdated
  editors.firstUpdated = async function (changed) {
    if (!views.has(this)) return await firstUpdated.call(this, changed)
    const { monaco, ok } = await configureTsx()
    await firstUpdated.call(this, changed)
    const editor = this.editor?.monacoEditor
    const created = editor?.getModel()
    if (!monaco || !editor || !created) return
    if (!ok) {
      // Without the dialect, TypeScript reads a view as a plain `.ts` file and
      // underlines every tag in it. Plain text says less and lies less.
      monaco.editor.setModelLanguage(created, 'plaintext')
      return
    }
    // monaco names the model it creates `inmemory://model/1`, and a name with no
    // `.tsx` on it is a file TypeScript refuses to read JSX in — every tag in
    // the view would be a syntax error. So the model is replaced by one named
    // as the file it is.
    const model = monaco.editor.createModel(
      created.getValue(),
      'typescript',
      monaco.Uri.parse(`${VIEWS}/view-${++opened}.tsx`),
    )
    editor.setModel(model)
    created.dispose()
    editor.onDidDispose(() => model.dispose())
  }

  const insert = editors.insert
  editors.insert = function (text) {
    return insert.call(this, views.has(this) ? toTsxSnippet(text) : text)
  }
}

/**
 * The template editor's inserts that cannot become TSX. A partial view is an
 * import as well as a tag, which an insert at the cursor cannot write, and
 * sections are Razor's way for a layout to take content from a page, where a
 * TSX layout takes props.
 */
async function hideRazorInserts() {
  const menu = (await customElements.whenDefined('umb-templating-insert-menu')).prototype
  Object.defineProperty(menu, 'hidePartialViews', {
    configurable: true,
    get: () => true,
    set: () => {},
  })

  const editor = (await customElements.whenDefined('umb-template-workspace-editor')).prototype
  const updated = editor.updated
  editor.updated = function (changed) {
    updated?.call(this, changed)
    const sections = this.shadowRoot?.querySelector('#sections-button')
    if (sections) sections.style.display = 'none'
  }
}

/**
 * The value builder's preview shows the snippet it will insert, so it shows the
 * TSX one. Its output is still Umbraco's, and is translated on insert with the rest.
 */
async function previewFieldsAsTsx() {
  const modal = (await customElements.whenDefined('umb-templating-page-field-builder-modal'))
    .prototype
  const render = modal.render
  modal.render = function () {
    const result = render.call(this)
    if (Array.isArray(result?.values)) result.values = result.values.map(toTsxSnippet)
    return result
  }
  const updated = modal.updated
  modal.updated = function (changed) {
    updated?.call(this, changed)
    const block = this.shadowRoot?.querySelector('umb-code-block')
    if (block && block.getAttribute('language') !== 'TypeScript') {
      block.setAttribute('language', 'TypeScript')
      block.language = 'TypeScript'
    }
  }
}

export const onInit = async () => {
  teachDialect(UmbCodeEditorElement.prototype)
  // Registered lazily, so these wait for the editor to be opened
  hideRazorInserts()
  previewFieldsAsTsx()

  const repository = UmbTemplateDetailRepository.prototype
  const createScaffold = repository.createScaffold
  repository.createScaffold = async function (preset) {
    const result = await createScaffold.call(this, preset)
    if (result.data) result.data.content = SCAFFOLD
    return result
  }

  const partialViews = UmbPartialViewDetailRepository.prototype
  const createPartialViewScaffold = partialViews.createScaffold
  partialViews.createScaffold = async function (preset) {
    const result = await createPartialViewScaffold.call(this, preset)
    // Started from a snippet it has content already; empty, it gets the skeleton
    if (result.data && !result.data.content) {
      const { data } = await PartialViewService.getPartialViewSnippetById({ path: { id: 'Empty' } })
      if (data?.content) result.data.content = data.content
    }
    return result
  }

  // The workspace context is not exported; it is the module beside the package's
  // entry, which the import map resolves to the very module Umbraco loads
  const { UmbTemplateWorkspaceContext } = await import(
    new URL(
      './workspace/template-workspace.context.js',
      import.meta.resolve('@umbraco-cms/backoffice/template'),
    ).href
  )
  const workspace = UmbTemplateWorkspaceContext.prototype
  const setLayoutTemplate = workspace.setLayoutTemplate
  workspace.setLayoutTemplate = async function (unique, updateLayoutBlock) {
    // Umbraco's own update writes Razor; the state it keeps is what we want
    await setLayoutTemplate.call(this, unique, false)
    if (!updateLayoutBlock) return unique
    const items = unique ? (await this.itemRepository.requestItems([unique])).data : []
    const content = this._data.getCurrent()?.content ?? ''
    this._data.updateCurrent({
      content: withLayout(content, items?.[0]?.alias ?? null),
      layoutTemplate: unique ? { unique } : null,
    })
    return unique
  }
}
