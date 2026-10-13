import { type PageProps, SeoHead } from 'bunbraco'

export default function HomePage(props: PageProps) {
  const { model } = props
  return (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        {/* The title, description and sharing tags, from the page's Search & sharing tab. */}
        <SeoHead {...props} title={model.text('title')} />
      </head>
      <body>
        <main>
          <h1>{model.text('title')}</h1>
          {/* Rich text is stored as HTML, so it is written out as HTML. */}
          <div setInnerHTML={{ __html: model.text('bodyText'), dangerously: true }} />
        </main>
      </body>
    </html>
  )
}
