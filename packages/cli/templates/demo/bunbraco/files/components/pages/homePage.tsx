import type { PageProps } from 'bunbraco'
import { FeatureCards, FeatureChecklist } from '../shared/features.tsx'
import { Layout } from '../shared/layout.tsx'
import { Logo } from '../shared/logo.tsx'
import { developerPage, elementsOf, repositoryUrl } from '../shared/site.tsx'

export default function HomePage({ model, nav }: PageProps) {
  const developers = developerPage(nav)
  return (
    <Layout model={model} nav={nav}>
      <section class="hero">
        <div class="container">
          <Logo size="large" />
          <h1>{model.text('title')}</h1>
          {model.hasValue('strapline') ? <p class="strapline">{model.text('strapline')}</p> : null}
          <div class="actions">
            {model.hasValue('heroCtaLabel') ? (
              <a class="button" href="#get-started">
                {model.text('heroCtaLabel')}
              </a>
            ) : null}
            <a class="button button--outline" href="#why">
              Why Bunbraco
            </a>
          </div>
        </div>
      </section>

      <section id="why" class="section">
        <div class="container">
          <h2>{model.text('whyHeading')}</h2>
          {model.hasValue('whyIntro') ? <p class="lead">{model.text('whyIntro')}</p> : null}
          <FeatureCards items={elementsOf(model, 'reasons')} />
        </div>
      </section>

      <section id="editors" class="section section--white">
        <div class="container">
          <h2>{model.text('editorsHeading')}</h2>
          {model.hasValue('editorsIntro') ? <p class="lead">{model.text('editorsIntro')}</p> : null}
          <div class="two-col">
            <FeatureChecklist items={elementsOf(model, 'editorFeatures')} />
            {model.hasValue('migrateHeading') ? (
              <aside class="card card--feature">
                <h3>{model.text('migrateHeading')}</h3>
                <div class="prose">{model.html('migrateBody')}</div>
              </aside>
            ) : null}
          </div>
        </div>
      </section>

      {developers ? (
        <section class="section section--dark">
          <div class="container narrow">
            <h2>{model.text('developersHeading')}</h2>
            {model.hasValue('developersIntro') ? (
              <p class="lead">{model.text('developersIntro')}</p>
            ) : null}
            {model.hasValue('developersCtaLabel') ? (
              <a class="button" href={developers.url}>
                {model.text('developersCtaLabel')}
              </a>
            ) : null}
          </div>
        </section>
      ) : null}

      <section id="get-started" class="cta">
        <div class="container narrow">
          <h2>{model.text('closingHeading')}</h2>
          {model.hasValue('closingBody') ? <p class="lead">{model.text('closingBody')}</p> : null}
          {model.hasValue('installCommand') ? (
            <pre class="code code--inline">
              <code>{model.text('installCommand')}</code>
            </pre>
          ) : null}
          <div class="actions">
            <a class="button" href={repositoryUrl(nav)}>
              View on GitHub
            </a>
            {developers ? (
              <a class="button button--outline" href={developers.url}>
                Developer guide
              </a>
            ) : null}
          </div>
        </div>
      </section>
    </Layout>
  )
}
