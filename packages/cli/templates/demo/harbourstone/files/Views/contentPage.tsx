import { Form, type PageProps, type SchemaForm } from 'bunbraco'
import { Layout } from './components/layout.tsx'

export default function ContentPage({ model, nav, submission }: PageProps) {
  const hero = model.media('heroImage')[0]
  // A `formPicker` property arrives as the definition itself, so there is
  // nothing to look up here. `value()` is untyped — `bunbraco generate` is what
  // types a model — so the cast is what a hand-written view pays.
  //
  // `submission` is what just happened to a post on this page: passing it
  // through is what makes a refused submission come back with its errors inside
  // this layout rather than on a bare page.
  const enquiry = model.value('enquiryForm') as SchemaForm | null
  return (
    <Layout model={model} nav={nav}>
      <article class="page">
        <h1>{model.text('title')}</h1>
        {hero ? <img src={hero.cropUrl({ width: 1200, height: 520 })} alt={hero.name} /> : null}
        <div class="prose" setInnerHTML={{ __html: model.text('bodyText'), dangerously: true }} />
        {enquiry ? <Form form={enquiry} submission={submission} /> : null}
      </article>
    </Layout>
  )
}
