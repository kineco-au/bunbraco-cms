import type { PageProps } from '@crombolo/crombolo'

export default function ContentPage({ model }: PageProps) {
  return (
    <div>
      <h1>{model.name}</h1>
    </div>
  )
}
