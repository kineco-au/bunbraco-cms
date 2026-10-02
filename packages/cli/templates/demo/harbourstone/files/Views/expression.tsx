import type { PageProps, PublishedElement } from 'bunbraco'
import { Layout } from './components/layout.tsx'

export default function Expression({ model, nav }: PageProps) {
  const bottle = model.media('bottleImage')[0]
  // An element picker always yields a list, as Umbraco's converter does, even
  // where the data type allows a single pick.
  const notes = (model.value('tastingNotes') ?? []) as PublishedElement[]
  return (
    <Layout model={model} nav={nav}>
      <article class="bottling">
        <div class="bottling-image">
          {bottle ? (
            <img src={bottle.cropUrl({ width: 600, height: 600 })} alt={bottle.name} />
          ) : null}
        </div>
        <div class="bottling-text">
          <h1>{model.text('title')}</h1>
          <p class="meta">
            {model.hasValue('age') ? `${model.text('age')} years in cask` : 'No age statement'}
            {model.hasValue('abv') ? ` · ${model.text('abv')}` : ''}
          </p>
          <div class="prose" setInnerHTML={{ __html: model.text('bodyText'), dangerously: true }} />
          {notes.length > 0 ? (
            <dl class="tasting">
              {notes.map((note) => (
                <>
                  <dt>{note.text('aspect')}</dt>
                  <dd>{note.text('note')}</dd>
                </>
              ))}
            </dl>
          ) : null}
        </div>
      </article>
    </Layout>
  )
}
