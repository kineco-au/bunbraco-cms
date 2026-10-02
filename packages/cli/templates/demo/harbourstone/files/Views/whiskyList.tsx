import type { PageProps } from 'bunbraco'
import { Layout } from './components/layout.tsx'

export default function WhiskyList({ model, nav }: PageProps) {
  return (
    <Layout model={model} nav={nav}>
      <article class="page">
        <h1>{model.text('title')}</h1>
        <div class="prose" setInnerHTML={{ __html: model.text('intro'), dangerously: true }} />
        <ul class="range">
          {nav.children(model).map((bottling) => {
            const bottle = bottling.media('bottleImage')[0]
            return (
              <li>
                <a href={bottling.url}>
                  {bottle ? (
                    <img src={bottle.cropUrl({ width: 400, height: 400 })} alt={bottle.name} />
                  ) : null}
                  <h2>{bottling.text('title')}</h2>
                  <p class="meta">
                    {bottling.hasValue('age')
                      ? `${bottling.text('age')} years`
                      : 'No age statement'}
                    {bottling.hasValue('abv') ? ` · ${bottling.text('abv')}` : ''}
                  </p>
                </a>
              </li>
            )
          })}
        </ul>
      </article>
    </Layout>
  )
}
