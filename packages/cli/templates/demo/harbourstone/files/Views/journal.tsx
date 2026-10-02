import type { PageProps } from 'bunbraco'
import { Layout, longDate } from './components/layout.tsx'

export default function Journal({ model, nav }: PageProps) {
  return (
    <Layout model={model} nav={nav}>
      <article class="page">
        <h1>{model.text('title')}</h1>
        <div class="prose" setInnerHTML={{ __html: model.text('intro'), dangerously: true }} />
        <ul class="entries">
          {nav.children(model).map((entry) => (
            <li>
              <p class="meta">{longDate(entry.value('publishedOn'))}</p>
              <h2>
                <a href={entry.url}>{entry.text('title')}</a>
              </h2>
              <p>{entry.text('summary')}</p>
            </li>
          ))}
        </ul>
      </article>
    </Layout>
  )
}
