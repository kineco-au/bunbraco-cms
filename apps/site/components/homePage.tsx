import { type PageProps, type PublishedElement, SeoHead } from '@crombolo/crombolo'

export default function HomePage(props: PageProps) {
  const { model } = props
  // An element picker always yields a list, as Umbraco's converter does, even
  // where the data type allows a single pick.
  const quotes = (model.value('quotes') ?? []) as PublishedElement[]
  return (
    <html lang="en">
      <head>
        <SeoHead {...props} />
      </head>
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
