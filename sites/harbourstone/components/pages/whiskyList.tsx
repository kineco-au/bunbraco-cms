import type { PageProps } from 'bunbraco'
import { BottlingCard } from '../shared/bottling.tsx'
import { Layout } from '../shared/layout.tsx'
import { PageHeader } from '../shared/section-intro.tsx'

export default function WhiskyList({ model, nav }: PageProps) {
  return (
    <Layout model={model} nav={nav}>
      <PageHeader model={model} />
      <section>
        <ul class="bottlings">
          {nav.children(model).map((bottling) => (
            <BottlingCard bottling={bottling} detailed />
          ))}
        </ul>
      </section>
    </Layout>
  )
}
