import type { PublishedElement } from 'bunbraco'

/** Features as cards: a heading, and the sentence that earns it. */
export function FeatureCards({ items }: { items: PublishedElement[] }) {
  if (items.length === 0) return null
  return (
    <div class="cards">
      {items.map((item) => (
        <article class="card">
          <h3>{item.text('heading')}</h3>
          {item.text('detail') ? <p>{item.text('detail')}</p> : null}
        </article>
      ))}
    </div>
  )
}

/** The same elements as a ticked list. */
export function FeatureChecklist({ items }: { items: PublishedElement[] }) {
  if (items.length === 0) return null
  return (
    <ul class="checklist">
      {items.map((item) => (
        <li>
          <strong>{item.text('heading')}</strong>
          {item.text('detail') ? <span>{item.text('detail')}</span> : null}
        </li>
      ))}
    </ul>
  )
}
