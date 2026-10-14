import type { PageProps, PublishedElement } from 'bunbraco'
import { specOf, TastingNotes } from '../shared/bottling.tsx'
import { Layout } from '../shared/layout.tsx'
import { Eyebrow } from '../shared/section-intro.tsx'

export default function Expression({ model, nav }: PageProps) {
  const bottle = model.media('bottleImage')[0]
  const notes = (model.value('tastingNotes') ?? []) as PublishedElement[]
  const range = nav.parent(model)
  return (
    <Layout model={model} nav={nav}>
      <article class="bottling">
        <div class="bottling__image">
          {bottle ? (
            <img src={bottle.cropUrl({ width: 760, height: 1140 })} alt={bottle.name} />
          ) : null}
        </div>
        <div class="bottling__text">
          <Eyebrow>{specOf(model)}</Eyebrow>
          <h1>{model.text('title')}</h1>
          {model.hasValue('summary') ? <p class="standfirst">{model.text('summary')}</p> : null}
          <div class="prose" setInnerHTML={{ __html: model.text('bodyText'), dangerously: true }} />
          <TastingNotes notes={notes} />
          {range ? (
            <p class="back">
              <a href={range.url}>Back to {range.text('title')}</a>
            </p>
          ) : null}
        </div>
      </article>
    </Layout>
  )
}
