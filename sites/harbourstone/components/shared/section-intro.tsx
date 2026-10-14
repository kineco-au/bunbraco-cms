import type { Child, PublishedContent } from 'bunbraco'

/** The small letter-spaced line that sits above every heading on this site. */
export function Eyebrow({ children, tone }: { children?: Child; tone?: 'light' }) {
  if (!children) return null
  return <p class={tone === 'light' ? 'eyebrow eyebrow--light' : 'eyebrow'}>{children}</p>
}

/**
 * The header at the top of a page: eyebrow, title, standfirst. Reads the three
 * properties by the aliases every page type here shares, so a new page type
 * gets the same header by naming its properties the same way.
 */
export function PageHeader({ model }: { model: PublishedContent }) {
  return (
    <header class="page-header">
      <Eyebrow>{model.text('eyebrow')}</Eyebrow>
      <h1>{model.text('title')}</h1>
      {model.hasValue('standfirst') ? <p class="standfirst">{model.text('standfirst')}</p> : null}
    </header>
  )
}

/** An eyebrow and a heading, for a section inside a page. */
export function SectionIntro({
  eyebrow,
  heading,
  tone,
}: {
  eyebrow: string
  heading: string
  tone?: 'light'
}) {
  return (
    <>
      <Eyebrow tone={tone}>{eyebrow}</Eyebrow>
      {heading ? <h2>{heading}</h2> : null}
    </>
  )
}
