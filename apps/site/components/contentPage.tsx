import type { PageProps } from 'bunbraco'

export default function ContentPage({ model }: PageProps) {
  return (
    <div>
      <h1>{model.name}</h1>
    </div>
  )
}
