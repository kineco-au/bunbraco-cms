import type { PublishedContent, PublishedElement } from 'bunbraco'

/**
 * An element picker always yields a list, as Umbraco's converter does, even
 * where the data type allows a single pick.
 */
export function highlightsOf(model: PublishedContent, alias: string): PublishedElement[] {
  return (model.value(alias) ?? []) as PublishedElement[]
}

/** The figures beside the house style: a heading set large, a line under it. */
export function Figures({ items }: { items: PublishedElement[] }) {
  if (items.length === 0) return null
  return (
    <dl class="figures">
      {items.map((item) => (
        <div>
          <dt>{item.text('heading')}</dt>
          <dd>{item.text('detail')}</dd>
        </div>
      ))}
    </dl>
  )
}

/** The same elements as a divided list: a short word, then the line beside it. */
export function HighlightRows({ items }: { items: PublishedElement[] }) {
  if (items.length === 0) return null
  return (
    <ul class="highlight-rows">
      {items.map((item) => (
        <li>
          <span class="highlight-rows__heading">{item.text('heading')}</span>
          <span>{item.text('detail')}</span>
        </li>
      ))}
    </ul>
  )
}
