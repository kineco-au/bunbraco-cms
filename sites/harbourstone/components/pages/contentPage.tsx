import type { PageProps } from 'bunbraco'
import { HighlightRows, highlightsOf } from '../shared/highlights.tsx'
import { Layout } from '../shared/layout.tsx'
import { PageHeader, SectionIntro } from '../shared/section-intro.tsx'

export default function ContentPage({ model, nav }: PageProps) {
  const image = model.media('heroImage')[0]
  const highlights = highlightsOf(model, 'highlights')
  const highlightsImage = model.media('highlightsImage')[0]
  return (
    <Layout model={model} nav={nav}>
      <PageHeader model={model} />

      <section class="split split--image-first">
        {image ? (
          <img
            class="split__image"
            src={image.cropUrl({ width: 1200, height: 800 })}
            alt={image.name}
          />
        ) : null}
        <div>
          <SectionIntro
            eyebrow={model.text('sectionEyebrow')}
            heading={model.text('sectionHeading')}
          />
          <div class="prose" setInnerHTML={{ __html: model.text('bodyText'), dangerously: true }} />
        </div>
      </section>

      {highlights.length > 0 ? (
        <section class="band band--dark">
          <div class="split">
            <div>
              <SectionIntro
                eyebrow={model.text('highlightsEyebrow')}
                heading={model.text('highlightsHeading')}
                tone="light"
              />
              <HighlightRows items={highlights} />
            </div>
            {highlightsImage ? (
              <img
                class="split__image"
                src={highlightsImage.cropUrl({ width: 1200, height: 800 })}
                alt={highlightsImage.name}
              />
            ) : null}
          </div>
        </section>
      ) : null}
    </Layout>
  )
}
