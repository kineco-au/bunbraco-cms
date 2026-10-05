import type { PageProps } from 'bunbraco'

export default function HomePage({ model }: PageProps) {
  return (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>{model.text('title')}</title>
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
