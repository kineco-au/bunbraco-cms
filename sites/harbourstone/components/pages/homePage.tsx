import type { PageProps } from 'bunbraco'
import { BottlingCard } from '../shared/bottling.tsx'
import { Figures, highlightsOf } from '../shared/highlights.tsx'
import { Layout } from '../shared/layout.tsx'
import { Eyebrow, SectionIntro } from '../shared/section-intro.tsx'

export default function HomePage({ model, nav }: PageProps) {
  const hero = model.media('heroImage')[0]
  const styleImage = model.media('styleImage')[0]
  // The range is whichever child is the list, rather than a hard-coded path:
  // rename or move it in the backoffice and these two sections follow.
  const range = nav.children(model).find((child) => child.contentType.alias === 'whiskyList')
  const bottlings = range ? nav.children(range) : []
  return (
    <Layout model={model} nav={nav}>
      <section class="hero">
        {hero ? (
          <img
            class="hero__image"
            src={hero.cropUrl({ width: 1600, height: 900 })}
            alt={hero.name}
          />
        ) : null}
        <div class="hero__text">
          <Eyebrow tone="light">{model.text('eyebrow')}</Eyebrow>
          <h1>{model.text('title')}</h1>
          <p class="strapline">{model.text('strapline')}</p>
          {range && model.hasValue('heroCtaLabel') ? (
            <a class="button button--light" href={range.url}>
              {model.text('heroCtaLabel')}
            </a>
          ) : null}
        </div>
      </section>

      <section class="split">
        <div>
          <SectionIntro eyebrow={model.text('styleEyebrow')} heading={model.text('styleHeading')} />
          <div
            class="prose"
            setInnerHTML={{ __html: model.text('styleIntro'), dangerously: true }}
          />
          <Figures items={highlightsOf(model, 'stats')} />
        </div>
        {styleImage ? (
          <img
            class="split__image"
            src={styleImage.cropUrl({ width: 1200, height: 800 })}
            alt={styleImage.name}
          />
        ) : null}
      </section>

      {range ? (
        <section class="band">
          <SectionIntro eyebrow={model.text('rangeEyebrow')} heading={model.text('rangeHeading')} />
          <ul class="bottlings bottlings--brief">
            {bottlings.map((bottling) => (
              <BottlingCard bottling={bottling} />
            ))}
          </ul>
          {model.hasValue('rangeCtaLabel') ? (
            <a class="button" href={range.url}>
              {model.text('rangeCtaLabel')}
            </a>
          ) : null}
        </section>
      ) : null}
    </Layout>
  )
}
