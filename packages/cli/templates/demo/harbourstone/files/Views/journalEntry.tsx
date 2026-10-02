import type { PageProps } from 'bunbraco'
import { Layout, longDate } from './components/layout.tsx'

export default function JournalEntry({ model, nav }: PageProps) {
  const hero = model.media('heroImage')[0]
  const journal = nav.parent(model)
  return (
    <Layout model={model} nav={nav}>
      <article class="page">
        <p class="meta">{longDate(model.value('publishedOn'))}</p>
        <h1>{model.text('title')}</h1>
        {hero ? <img src={hero.cropUrl({ width: 1200, height: 520 })} alt={hero.name} /> : null}
        <div class="prose" setInnerHTML={{ __html: model.text('bodyText'), dangerously: true }} />
        {journal ? (
          <p class="back">
            <a href={journal.url}>Back to {journal.text('title')}</a>
          </p>
        ) : null}
      </article>
    </Layout>
  )
}
