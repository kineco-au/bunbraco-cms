import type { PublishedContent, PublishedElement } from 'bunbraco'

/**
 * The line over a bottling's name: kind, strength, and either an age or a
 * batch. Composed here rather than typed into a field, so an editor who changes
 * the age does not also have to remember to change a string that repeats it.
 */
export function specOf(bottling: PublishedContent): string {
  const parts = [bottling.text('kind'), bottling.text('abv')]
  if (bottling.hasValue('age')) parts.push(`${bottling.text('age')} years`)
  else if (bottling.hasValue('batch')) parts.push(`Batch ${bottling.text('batch')}`)
  return parts.filter(Boolean).join(' · ')
}

export function TastingNotes({ notes }: { notes: PublishedElement[] }) {
  if (notes.length === 0) return null
  return (
    <dl class="tasting">
      {notes.map((note) => (
        <div>
          <dt>{note.text('aspect')}</dt>
          <dd>{note.text('note')}</dd>
        </div>
      ))}
    </dl>
  )
}

/**
 * One bottling, as it appears in a list. `detailed` is what the range page
 * shows and the home page does not: the bottle itself and the tasting notes.
 */
export function BottlingCard({
  bottling,
  detailed,
}: {
  bottling: PublishedContent
  detailed?: boolean
}) {
  const bottle = bottling.media('bottleImage')[0]
  const notes = (bottling.value('tastingNotes') ?? []) as PublishedElement[]
  return (
    <li class="bottling-card">
      {detailed && bottle ? (
        <a class="bottling-card__image" href={bottling.url}>
          <img src={bottle.cropUrl({ width: 760, height: 1140 })} alt={bottle.name} />
        </a>
      ) : null}
      <div class="bottling-card__text">
        <p class="eyebrow">{specOf(bottling)}</p>
        <h3>
          <a href={bottling.url}>{bottling.text('title')}</a>
        </h3>
        {bottling.hasValue('summary') ? <p>{bottling.text('summary')}</p> : null}
        {detailed ? <TastingNotes notes={notes} /> : null}
      </div>
    </li>
  )
}
