import type { PageProps, PublishedElement } from 'bunbraco'

export default function HomePage({ model }: PageProps) {
  // An element picker always yields a list, as Umbraco's converter does, even
  // where the data type allows a single pick.
  const quotes = (model.value('quotes') ?? []) as PublishedElement[]
  return (
    <html lang="en">
      <body>
        <main>
          <h1>{model.text('title')}</h1>
          <div setInnerHTML={{ __html: model.text('bodyText'), dangerously: true }} />
          {quotes.map((quote) => (
            <blockquote>
              <p>{quote.text('body')}</p>
              {quote.text('attribution') ? <cite>{quote.text('attribution')}</cite> : null}
            </blockquote>
          ))}
        </main>
      </body>
    </html>
  )
}
