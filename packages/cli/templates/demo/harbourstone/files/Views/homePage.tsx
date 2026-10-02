import type { PageProps } from 'bunbraco'
import { Layout } from './components/layout.tsx'

export default function HomePage({ model, nav }: PageProps) {
  const hero = model.media('heroImage')[0]
  const sections = nav.children(model)
  return (
    <Layout model={model} nav={nav}>
      <article class="hero">
        {hero ? <img src={hero.cropUrl({ width: 1600, height: 700 })} alt={hero.name} /> : null}
        <div class="hero-text">
          <h1>{model.text('title')}</h1>
          <p class="strapline">{model.text('strapline')}</p>
        </div>
      </article>
      <section class="prose">
        <div setInnerHTML={{ __html: model.text('intro'), dangerously: true }} />
      </section>
      <section class="cards">
        {sections.map((section) => (
          <a class="card" href={section.url}>
            <h2>{section.text('title') || section.name}</h2>
            <p>{section.text('summary')}</p>
          </a>
        ))}
      </section>
    </Layout>
  )
}
