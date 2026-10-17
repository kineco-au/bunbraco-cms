import type { PageProps } from '@crombolo/crombolo'
import { DocsLayout, headingsOf } from '../shared/docs.tsx'

export default function DocsPage(props: PageProps) {
  const { model, nav } = props
  const children = nav
    .children(model, { visibleOnly: true })
    .filter((child) => child.contentType.alias === 'docsPage')
  const generatedFrom = model.text('generatedFrom')
  const editUrl = model.text('editUrl')
  return (
    <DocsLayout {...props} headings={headingsOf(model.text('body'))}>
      <div class="prose">{model.html('body')}</div>
      {/* A page that only groups others lists them, so it is never empty. */}
      {children.length > 0 && !model.hasValue('body') ? (
        <ul class="docs-index">
          {children.map((child) => (
            <li>
              <a href={child.url}>{child.name}</a>
              {child.hasValue('standfirst') ? <p>{child.text('standfirst')}</p> : null}
            </li>
          ))}
        </ul>
      ) : null}
      {generatedFrom || editUrl ? (
        <footer class="docs-source">
          {generatedFrom ? <p>Generated from {generatedFrom}.</p> : null}
          {editUrl ? (
            <p>
              <a href={editUrl}>Suggest a change to this page</a>
            </p>
          ) : null}
        </footer>
      ) : null}
    </DocsLayout>
  )
}
