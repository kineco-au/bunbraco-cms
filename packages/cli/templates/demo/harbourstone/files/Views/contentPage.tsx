import type { PageProps } from 'bunbraco'
import { Layout } from './components/layout.tsx'

export default function ContentPage({ model, nav }: PageProps) {
  const hero = model.media('heroImage')[0]
  return (
    <Layout model={model} nav={nav}>
      <article class="page">
        <h1>{model.text('title')}</h1>
        {hero ? <img src={hero.cropUrl({ width: 1200, height: 520 })} alt={hero.name} /> : null}
        <div class="prose" setInnerHTML={{ __html: model.text('bodyText'), dangerously: true }} />
      </article>
    </Layout>
  )
}
