import type { PageProps } from '@crombolo/crombolo'
import { Layout } from '../shared/layout.tsx'

/** A main column and a sidebar; with nothing in the sidebar, the main column takes the width. */
export default function ContentPage(props: PageProps) {
  const { model } = props
  const sidebar = model.hasValue('sidebarText')
  return (
    <Layout {...props}>
      <div class={sidebar ? 'columns' : undefined}>
        <article>
          <h1>{model.text('title') || model.name}</h1>
          {model.hasValue('intro') ? <p class="intro">{model.text('intro')}</p> : null}
          {model.html('bodyText')}
        </article>
        {sidebar ? (
          <aside>
            {model.hasValue('sidebarHeading') ? <h2>{model.text('sidebarHeading')}</h2> : null}
            {model.html('sidebarText')}
          </aside>
        ) : null}
      </div>
    </Layout>
  )
}
