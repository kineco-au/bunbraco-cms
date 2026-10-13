# Adding a page

A page on a Bunbraco site is three things: a **document type** that says what an
editor fills in, a **component** that turns it into HTML, and the **content** an
editor creates from that type. The first two are files in the site and go through
source control; the third lives in the database.

This walks through all three for an events page: a title, an introduction, and a
list of upcoming events fetched from another service while the page renders.

```
schema/document-types/events-page.toml   the document type
components/eventsPage.tsx                the page component
components/shared/layout.tsx             the layout it renders inside
```

## 1. The document type

`schema new` writes the type file, with its keys already filled in, and the
component it points at:

```bash
bunx bunbraco schema new document-type eventsPage --name "Events Page" --icon icon-calendar
bunx bunbraco schema add-property eventsPage intro --name "Introduction" --type richtext
bunx bunbraco schema add-property eventsPage feedUrl --name "Events feed URL" --type textstring --mandatory
```

A new type starts with a mandatory `title` on a Content tab. `--type` names a data
type by alias; the built-in ones include `textstring`, `textarea`, `richtext`,
`numeric`, `trueFalse`, `datePicker`, `contentPicker` and `mediaPicker`, and a site
can add its own under `schema/data-types/`. `schema add-property --dry-run` prints
the file instead of writing it.

The result is `schema/document-types/events-page.toml`:

```toml
[document-type]
key = "6670caff-52e7-4807-9e28-532f2e5542ae"
alias = "eventsPage"
name = "Events Page"
icon = "icon-calendar"
components = ["eventsPage"]
default-component = "eventsPage"

[[tab]]
name = "Content"

[[tab.property]]
key = "509eca6f-888a-4251-8abf-88a10ffd1891"
alias = "title"
name = "Title"
description = "Shown as the page heading"
type = "textstring"
mandatory = true

[[tab.property]]
key = "…"
alias = "intro"
name = "Introduction"
type = "richtext"

[[tab.property]]
key = "…"
alias = "feedUrl"
name = "Events feed URL"
type = "textstring"
mandatory = true
```

`components` lists the components an editor may pick for a page of this type, and
`default-component` is the one a new page gets.

**Say where it may be created.** A type is only offered where something allows
it. Add it to the parent's `allow-children`, here the home page's:

```toml
# schema/document-types/home-page.toml
allow-children = ["contentPage", "eventsPage"]
```

or pass `--at-root` to `schema new` (`allow-at-root = true` in the file) for a
page that sits at the top of the tree. To share fields between types, such as the
Search & sharing tab, list them in `compositions = ["seoFields"]`.

The document type can also be built in the backoffice under Settings → Document
Types. In development, saving it there writes the same file.
[`09-schema-as-code.md`](09-schema-as-code.md) has the whole format.

## 2. The component

`schema new` wrote a starter `components/eventsPage.tsx`. A component is a
function from the page's props to markup. `model` is the page being rendered, and
`model.text('alias')` reads a property as text. Here it is replaced with one that
renders inside a shared layout and fetches the events:

```tsx
// components/eventsPage.tsx
import type { PageProps } from 'bunbraco'
import { Layout } from './shared/layout.tsx'

interface UpcomingEvent {
  id: string
  title: string
  startsAt: string
  venue: string
}

/** The feed's events, or undefined when it cannot be reached. */
async function upcoming(
  feedUrl: string,
  signal: AbortSignal,
): Promise<UpcomingEvent[] | undefined> {
  try {
    const response = await fetch(feedUrl, { signal, headers: { accept: 'application/json' } })
    if (!response.ok) return undefined
    return (await response.json()) as UpcomingEvent[]
  } catch (error) {
    // Out of time, or the visitor left: let the render stop.
    if (signal.aborted) throw error
    // The feed is down: render the page without it.
    return undefined
  }
}

async function EventList({ feedUrl, signal }: { feedUrl: string; signal: AbortSignal }) {
  const events = await upcoming(feedUrl, signal)
  if (!events) return <p class="events__unavailable">Upcoming events can't be shown right now.</p>
  if (events.length === 0) return <p>Nothing is scheduled yet.</p>
  return (
    <ul class="events">
      {events.map((event) => (
        <li>
          <time datetime={event.startsAt}>
            {new Date(event.startsAt).toLocaleDateString('en-AU', { dateStyle: 'medium' })}
          </time>{' '}
          {event.title}, {event.venue}
        </li>
      ))}
    </ul>
  )
}

export default function EventsPage(props: PageProps) {
  const { model, signal } = props
  return (
    <Layout {...props}>
      <h1>{model.text('title')}</h1>
      <div setInnerHTML={{ __html: model.text('intro'), dangerously: true }} />
      <EventList feedUrl={model.text('feedUrl')} signal={signal} />
    </Layout>
  )
}
```

```tsx
// components/shared/layout.tsx
import type { Child, PageProps } from 'bunbraco'

export function Layout({ model, children }: PageProps & { children?: Child }) {
  return (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <title>{model.text('title')}</title>
      </head>
      <body>
        <main>{children}</main>
      </body>
    </html>
  )
}
```

Some things to know:

- **Only a component a type names is a page.** Anything else under
  `components/`, like `shared/layout.tsx`, is reached only by an `import`, and only
  from inside `components/`. Create one with `bunx bunbraco components new shared/layout`.
- **A component may be `async`.** `EventsPage` itself is synchronous: `EventList`
  is async, and the page waits for it before it is sent. Async components side
  by side start together.
- **Pass `signal` to anything a component waits on.** It aborts when the render
  runs out of time (10 seconds by default, `BUNBRACO_RENDER_TIMEOUT_MS`) or the
  visitor disconnects. A render past its time fails like any template error: it is
  logged, naming the component, and the visitor gets a server error.
- **Decide what a failure looks like.** An error a component throws fails the
  whole page. `upcoming` catches a feed that is down and shows a line in its place,
  and lets an abort through so the render stops.
- **Text is escaped.** `{event.title}` cannot inject markup. Rich text is stored as
  HTML, so `intro` is written out with `setInnerHTML` and `dangerously: true`.
  [`05-rendering.md`](05-rendering.md) has the rest of the model API, layouts and
  async components.

## 3. Check it

```bash
bunx bunbraco schema check --static   # the files parse and agree with each other
bunx bunbraco components check        # every component compiles and imports; every named one exists
bunx bunbraco generate                # schema/content-types.d.ts: an interface per type
```

`components check` imports every component, so a broken import shows up here
rather than when a visitor opens the page.

## 4. The content

With the site running (`bun start`), the type is applied as soon as its file is
saved: in development the server watches `schema/`. The `schema` commands above
also apply what they write.

In the backoffice:

1. Open **Content** and find the page the new one belongs under, the home page
   here.
2. Choose **Create** from its actions menu, then **Events Page**. Only types the
   parent allows are offered.
3. Fill in the title, the introduction and the feed URL.
4. **Save and publish**.

The page's address comes from its name and its place in the tree. The home page
is `/`, and its name is left out of the addresses below it, so an "Events" page
under it is at `/events`. The page's **Info** tab shows which component it
renders with, chosen from the type's `components`.

## 5. Shipping it

Commit `schema/` and `components/`. Content is not in the files, so it is created
in each environment, or moved with a content bundle
([`13-content-transfer.md`](13-content-transfer.md)).

A production node only applies schema files carrying a newer version, so bump
`schema/schema.toml` with the change, or deploy with a newer
`BUNBRACO_SCHEMA_REVISION`. In production the backoffice cannot change a
document type: it says the type lives in `schema/` and must be changed there.
[`10-packaging-and-upgrades.md`](10-packaging-and-upgrades.md) has the details.
