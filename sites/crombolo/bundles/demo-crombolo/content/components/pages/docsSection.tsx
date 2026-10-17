import type { PageProps } from '@crombolo/crombolo'
import { DocsLayout } from '../shared/docs.tsx'

/** The front page of the docs: its introduction, then every top-level page and what is under it. */
export default function DocsSection(props: PageProps) {
  const { model, nav } = props
  const pages = (parent: typeof model) =>
    nav
      .children(parent, { visibleOnly: true })
      .filter((child) => child.contentType.alias === 'docsPage')
  return (
    <DocsLayout {...props}>
      {model.hasValue('body') ? <div class="prose">{model.html('body')}</div> : null}
      <div class="docs-contents">
        {pages(model).map((page) => (
          <section>
            <h2>
              <a href={page.url}>{page.name}</a>
            </h2>
            {page.hasValue('standfirst') ? <p>{page.text('standfirst')}</p> : null}
            {pages(page).length > 0 ? (
              <ul>
                {pages(page).map((child) => (
                  <li>
                    <a href={child.url}>{child.name}</a>
                  </li>
                ))}
              </ul>
            ) : null}
          </section>
        ))}
      </div>
    </DocsLayout>
  )
}
