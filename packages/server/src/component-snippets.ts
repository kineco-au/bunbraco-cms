/**
 * The components the backoffice offers to start from — Umbraco's snippets, with
 * its ids, written as TSX. One is rendered the way any component is:
 * `<Breadcrumb model={model} nav={nav} />`. `Empty` is also the skeleton a new
 * component starts with.
 */
import type { Snippet } from '@bunbraco/api-management'

const IMPORTS = "import type { PageProps } from 'bunbraco'\n\n"

export const COMPONENT_SNIPPETS: readonly Snippet[] = [
  {
    id: 'Empty',
    name: 'Empty',
    content: `${IMPORTS}export default function Partial({ model }: Pick<PageProps, 'model'>) {
  return <div>{model.name}</div>
}
`,
  },
  {
    id: 'Breadcrumb',
    name: 'Breadcrumb',
    content: `${IMPORTS}export default function Breadcrumb({ model, nav }: Pick<PageProps, 'model' | 'nav'>) {
  const trail = [...nav.ancestors(model)].reverse()
  return (
    <ul class="breadcrumb">
      {trail.map((page) => (
        <li>
          <a href={page.url}>{page.name}</a>
        </li>
      ))}
      <li class="active">{model.name}</li>
    </ul>
  )
}
`,
  },
  {
    id: 'ListAncestorsFromCurrentPage',
    name: 'List Ancestors From Current Page',
    content: `${IMPORTS}export default function Ancestors({ model, nav }: Pick<PageProps, 'model' | 'nav'>) {
  return (
    <ul>
      {nav.ancestors(model).map((page) => (
        <li>
          <a href={page.url}>{page.name}</a>
        </li>
      ))}
    </ul>
  )
}
`,
  },
  {
    id: 'ListChildPagesFromCurrentPage',
    name: 'List Child Pages From Current Page',
    content: `${IMPORTS}export default function ChildPages({ model, nav }: Pick<PageProps, 'model' | 'nav'>) {
  return (
    <ul>
      {nav.children(model).map((page) => (
        <li>
          <a href={page.url}>{page.name}</a>
        </li>
      ))}
    </ul>
  )
}
`,
  },
  {
    id: 'ListChildPagesOrderedByDate',
    name: 'List Child Pages Ordered By Date',
    content: `${IMPORTS}export default function ChildPagesByDate({ model, nav }: Pick<PageProps, 'model' | 'nav'>) {
  const pages = [...nav.children(model)].sort(
    (a, b) => b.createDate.getTime() - a.createDate.getTime(),
  )
  return (
    <ul>
      {pages.map((page) => (
        <li>
          <a href={page.url}>{page.name}</a>
        </li>
      ))}
    </ul>
  )
}
`,
  },
  {
    id: 'ListChildPagesOrderedByName',
    name: 'List Child Pages Ordered By Name',
    content: `${IMPORTS}export default function ChildPagesByName({ model, nav }: Pick<PageProps, 'model' | 'nav'>) {
  const pages = [...nav.children(model)].sort((a, b) => a.name.localeCompare(b.name))
  return (
    <ul>
      {pages.map((page) => (
        <li>
          <a href={page.url}>{page.name}</a>
        </li>
      ))}
    </ul>
  )
}
`,
  },
  {
    id: 'ListDescendantsFromCurrentPage',
    name: 'List Descendants From Current Page',
    content: `import type { PageProps, PublishedContent } from 'bunbraco'

export default function Descendants({ model, nav }: Pick<PageProps, 'model' | 'nav'>) {
  const branch = (page: PublishedContent) => (
    <ul>
      {nav.children(page).map((child) => (
        <li>
          <a href={child.url}>{child.name}</a>
          {nav.children(child).length > 0 ? branch(child) : null}
        </li>
      ))}
    </ul>
  )
  return branch(model)
}
`,
  },
  {
    id: 'Navigation',
    name: 'Navigation',
    content: `${IMPORTS}export default function Navigation({ model, nav }: Pick<PageProps, 'model' | 'nav'>) {
  const site = nav.ancestors(model).at(-1) ?? model
  return (
    <ul class="nav">
      {nav.children(site).map((page) => (
        <li class={page.id === model.id ? 'current' : undefined}>
          <a href={page.url}>{page.name}</a>
        </li>
      ))}
    </ul>
  )
}
`,
  },
  {
    id: 'SiteMap',
    name: 'Site Map',
    content: `import type { PageProps, PublishedContent } from 'bunbraco'

export default function SiteMap({ nav }: Pick<PageProps, 'nav'>) {
  const branch = (pages: PublishedContent[]) => (
    <ul>
      {pages.map((page) => (
        <li>
          <a href={page.url}>{page.name}</a>
          {nav.children(page).length > 0 ? branch(nav.children(page)) : null}
        </li>
      ))}
    </ul>
  )
  return <div class="sitemap">{branch(nav.root())}</div>
}
`,
  },
]
