/**
 * A TSX stub for each Umbraco template.
 *
 * Razor cannot be translated mechanically, so nothing here tries. Each template
 * gets a view that compiles, sits in the same layout chain and renders the
 * page's name — enough for the imported site to boot and every page to answer
 * — and the original is kept beside the report for whoever rewrites it.
 */
import type { SourceTemplate } from './schema.ts'

/** `checkout-step_page` → `CheckoutStepPage`; a name TSX accepts for a component. */
export function componentName(alias: string): string {
  const name = alias
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join('')
  return /^[A-Za-z]/.test(name) ? name : `View${name}`
}

export interface ViewStubOptions {
  /** Whether another template names this one as its layout. */
  isLayout: boolean
  /** Where the original Razor was put, when the backup had it. */
  original?: string
}

export function viewStub(template: SourceTemplate, options: ViewStubOptions): string {
  const name = componentName(template.alias)
  const header = [
    `// Imported from Umbraco: a stub for the Razor template "${template.name}".`,
    options.original
      ? `// The original is in ${options.original}; this renders nothing of it yet.`
      : '// The original Razor was not in the backup; this renders nothing of it yet.',
  ].join('\n')
  const layout = template.layout ? `\nexport const layout = '${template.layout}'\n` : ''

  if (options.isLayout) {
    const body = template.layout
      ? '  return <div>{children}</div>'
      : `  return (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <title>{model.name}</title>
      </head>
      <body>{children}</body>
    </html>
  )`
    return `import type { Child, PageProps } from 'bunbraco'

${header}
${layout}
export default function ${name}({ ${template.layout ? '' : 'model, '}children }: PageProps & { children?: Child }) {
${body}
}
`
  }

  const page = `<main>
      <h1>{model.name}</h1>
    </main>`
  const body = template.layout
    ? `  return (
    ${page}
  )`
    : `  return (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <title>{model.name}</title>
      </head>
      <body>
        <main>
          <h1>{model.name}</h1>
        </main>
      </body>
    </html>
  )`
  return `import type { PageProps } from 'bunbraco'

${header}
${layout}
export default function ${name}({ model }: PageProps) {
${body}
}
`
}

/**
 * Where a Razor view that is not a template lands under `components/`.
 *
 * The source site's own arrangement is kept, minus the `Views/` prefix it all
 * sat under: `Views/Partials/Hero.cshtml` becomes `components/Partials/Hero.tsx`.
 * Nothing here treats `Partials` as special — it is a folder the author chose,
 * and since a component may sit at any depth it can simply stay where it is.
 */
export function componentPathFor(razorPath: string): string {
  const withoutRoot = razorPath.replace(/^Views\//i, '')
  return `components/${withoutRoot.replace(/\.cshtml$/i, '.tsx')}`
}

/**
 * A stub for a Razor view that no document type names.
 *
 * It is a plain function rather than a default export taking `PageProps`: a
 * template is routed to, and this is imported, so it takes whatever the thing
 * importing it passes.
 */
export function componentStub(razorPath: string, original?: string): string {
  const base = razorPath.replace(/^.*\//, '').replace(/\.cshtml$/i, '')
  const name = componentName(base)
  return `${
    original
      ? `// Imported from Umbraco: a stub for the Razor view "${razorPath}".\n// The original is in ${original}; this renders nothing of it yet.`
      : `// Imported from Umbraco: a stub for the Razor view "${razorPath}".`
  }

export function ${name}() {
  return null
}
`
}
