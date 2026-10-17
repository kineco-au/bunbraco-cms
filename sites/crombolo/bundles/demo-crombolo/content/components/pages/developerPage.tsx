import type { PageProps } from '@crombolo/crombolo'
import { FeatureCards } from '../shared/features.tsx'
import { Layout } from '../shared/layout.tsx'
import { elementsOf, repositoryUrl } from '../shared/site.tsx'

export default function DeveloperPage(props: PageProps) {
  const { model, nav } = props
  const steps = elementsOf(model, 'steps')
  return (
    <Layout {...props}>
      <header class="page-header">
        <div class="container narrow">
          {model.hasValue('eyebrow') ? <p class="eyebrow">{model.text('eyebrow')}</p> : null}
          <h1>{model.text('title')}</h1>
          {model.hasValue('standfirst') ? (
            <p class="strapline">{model.text('standfirst')}</p>
          ) : null}
        </div>
      </header>

      {/* A section with no heading is left out, so a reference page shows only its prose. */}
      {model.hasValue('codeHeading') ? (
        <section class="section">
          <div class="container two-col two-col--top">
            <div>
              <h2>{model.text('codeHeading')}</h2>
              {model.hasValue('codeIntro') ? <p class="lead">{model.text('codeIntro')}</p> : null}
            </div>
            {/* Text, not markup: the sample is escaped, so its tags show as written. */}
            {model.hasValue('codeSample') ? (
              <pre class="code">
                <code>{model.text('codeSample')}</code>
              </pre>
            ) : null}
          </div>
        </section>
      ) : null}

      {model.hasValue('toolkitHeading') ? (
        <section class="section section--white">
          <div class="container">
            <h2>{model.text('toolkitHeading')}</h2>
            <FeatureCards items={elementsOf(model, 'toolkit')} />
          </div>
        </section>
      ) : null}

      <section id="getting-started" class="section">
        <div class="container narrow">
          {model.hasValue('stepsHeading') ? <h2>{model.text('stepsHeading')}</h2> : null}
          {steps.length > 0 ? (
            <ol class="steps">
              {steps.map((step) => (
                <li>
                  <h3>{step.text('heading')}</h3>
                  {step.text('detail') ? <p>{step.text('detail')}</p> : null}
                  {step.text('command') ? (
                    <pre class="code">
                      <code>{step.text('command')}</code>
                    </pre>
                  ) : null}
                </li>
              ))}
            </ol>
          ) : null}
          <div class="prose">{model.html('nextSteps')}</div>
          <p>
            <a class="button button--solid" href={repositoryUrl(nav)}>
              View the source on GitHub
            </a>
          </p>
        </div>
      </section>
    </Layout>
  )
}
