# Writing components

A component is a function that takes props and returns markup. Templates and
the components they import are ordinary `.tsx` files under `components/`, written
in JSX the way a React component is, but rendered once, on the server, to HTML.
[`20-adding-a-page.md`](20-adding-a-page.md) walks through making a page;
this is the cookbook for what goes inside one.

Every example below is a real file. Together they make the page at the end, and
`tests/docs-components.test.ts` renders that page from the blocks in this
document, so they stay correct.

## A component, and its props

```tsx
// components/shared/badge.tsx
import type { Child } from '@crombolo/crombolo'

interface BadgeProps {
  tone?: 'info' | 'warning'
  children: Child
}

export function Badge({ tone = 'info', children }: BadgeProps) {
  return <span class={`badge badge--${tone}`}>{children}</span>
}
```

- **Props are typed like any function's.** Give the props an interface, and every
  `<Badge>` is checked against it: a missing `children`, or `tone="error"`, is a
  type error.
- **`Child` is anything that renders:** text, numbers, markup, an array of them,
  `null` or `false` for nothing, or a promise of any of those.
- **`class` or `className`, `for` or `htmlFor`.** Both spellings work; HTML's are
  shorter.
- **Text is escaped.** `{children}` cannot inject markup; see "Raw HTML" for when
  markup is what you have.

## Lists and conditions

```tsx
// components/shared/card-list.tsx
import type { PublishedContent } from '@crombolo/crombolo'
import { Badge } from './badge.tsx'

const WEEK = 7 * 24 * 60 * 60 * 1000

export function CardList({ pages }: { pages: PublishedContent[] }) {
  if (pages.length === 0) return <p>Nothing here yet.</p>
  return (
    <ul class="cards">
      {pages.map((page) => (
        <li>
          <a href={page.url}>{page.name}</a>
          {Date.now() - page.updateDate.getTime() < WEEK && <Badge>New</Badge>}
        </li>
      ))}
    </ul>
  )
}
```

A list is an array: `map` over the items. `false`, `null` and `undefined` render as
nothing, so `condition && <Element />` shows the element only when the condition
holds. There is no `key` to give a list item; it is accepted and ignored.

## Styles and SVG

```tsx
// components/shared/hero.tsx
import type { Child } from '@crombolo/crombolo'

export function Hero({ image, children }: { image?: string; children: Child }) {
  return (
    <section
      class="hero"
      style={{
        backgroundImage: image ? `url(${image})` : undefined,
        minHeight: 320,
        '--hero-gap': '2rem',
      }}
    >
      {children}
    </section>
  )
}
```

```tsx
// components/shared/arrow-icon.tsx
export function ArrowIcon({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden={true}>
      <path
        d="M3 8h10M9 4l4 4-4 4"
        stroke="currentColor"
        strokeWidth={1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}
```

- **A `style` object is CSS.** `minHeight: 320` is `min-height:320px`: a number
  gets `px` where React would add it, and not on unitless properties like
  `opacity` or `zIndex`. A property set to `undefined` or `null` is left out.
  Custom properties (`--hero-gap`) are written as they are. A plain string works
  too: `style="color: red"`.
- **SVG attributes are written in camelCase** and come out as SVG spells them:
  `strokeWidth` is `stroke-width`.
- **`aria-*` and `data-*` take booleans** and write them as `"true"` and `"false"`.

## Raw HTML

Rich text is stored as HTML, so it is written out as HTML, not escaped:

```tsx
<div>{model.html('body')}</div>
<div setInnerHTML={{ __html: model.text('body'), dangerously: true }} />
<div dangerouslySetInnerHTML={{ __html: markupFromElsewhere }} />
```

`model.html()` is the short way for a property. `setInnerHTML` escapes unless
told `dangerously: true`, so forgetting the flag fails safe. React's
`dangerouslySetInnerHTML` is accepted as React writes it, verbatim. Never pass a
visitor's input to either.

## Forms, and ids

```tsx
// components/shared/newsletter-form.tsx
import { useId } from '@crombolo/crombolo'

export function NewsletterForm({ topics }: { topics: string[] }) {
  const email = useId()
  const topic = useId()
  const notes = useId()
  return (
    <form method="post" action="/newsletter">
      <label for={email}>Email</label>
      <input id={email} name="email" type="email" required />

      <label for={topic}>Topic</label>
      <select id={topic} name="topic" defaultValue={topics[0]}>
        {topics.map((name) => (
          <option value={name}>{name}</option>
        ))}
      </select>

      <label for={notes}>Notes</label>
      <textarea id={notes} name="notes" rows={3} defaultValue="" />

      <label>
        <input type="checkbox" name="updates" defaultChecked /> Send me updates
      </label>
      <button type="submit">Subscribe</button>
    </form>
  )
}
```

- **`useId()` gives an id unique within the page**, so two of these forms on one
  page do not share their labels' targets.
- **React's form props work.** `defaultValue` and `defaultChecked` are an input's
  `value` and `checked`; a `<textarea>`'s value is its text; a `<select>`'s
  `value` or `defaultValue` marks the matching `<option>` selected (a list, for
  `multiple`). The select can see only options written directly inside it, or
  inside an `<optgroup>`: one returned by another component has been written
  already, so put `selected` on it instead.
- A form built in the backoffice's Forms section is rendered with
  [`<Form>`](18-forms.md) rather than by hand.

## Async components

A component can wait for something: another service, a file, a slow query.

```tsx
// components/shared/upcoming-events.tsx
import { usePage } from '@crombolo/crombolo'

interface UpcomingEvent {
  title: string
  startsAt: string
}

export async function UpcomingEvents({ feedUrl }: { feedUrl: string }) {
  const { signal } = usePage()
  let events: UpcomingEvent[] | undefined
  try {
    const response = await fetch(feedUrl, { signal })
    events = response.ok ? ((await response.json()) as UpcomingEvent[]) : undefined
  } catch (error) {
    if (signal.aborted) throw error
  }
  if (!events) return <p>Upcoming events can't be shown right now.</p>
  return (
    <ol class="events">
      {events.map((event) => (
        <li>
          <time datetime={event.startsAt}>{event.startsAt.slice(0, 10)}</time> {event.title}
        </li>
      ))}
    </ol>
  )
}
```

- **The page waits for it** before anything is sent. Async components side by
  side start together; to wait for two things inside one, start both and
  `await Promise.all([...])`.
- **Pass `signal` to what you wait on.** It aborts when the page runs out of time
  (10 seconds by default) or the visitor leaves. `usePage()` hands it to any
  component without it being passed down.
- **Decide what a failure looks like.** An error a component throws fails the
  page. Catch the ones that should leave the rest of the page standing, and let an
  abort through.

## Context: values without props

Any component can read the page being rendered with `usePage()`, and a template's
own values can be handed down with a context:

```tsx
// components/shared/breadcrumbs.tsx
import { usePage } from '@crombolo/crombolo'

export function Breadcrumbs() {
  const { model, nav } = usePage()
  const trail = nav.ancestors(model).reverse()
  if (trail.length === 0) return null
  return (
    <nav aria-label="Breadcrumbs">
      {trail.map((page) => (
        <a href={page.url}>{page.name}</a>
      ))}
      <span aria-current="page">{model.name}</span>
    </nav>
  )
}
```

```tsx
// components/shared/theme.tsx
import { type Child, createContext, useContext } from '@crombolo/crombolo'

export const Theme = createContext<'light' | 'dark'>('light')

export function Panel({ children }: { children: Child }) {
  return <div class={`panel panel--${useContext(Theme)}`}>{children}</div>
}
```

A provider sets the value for what it renders, and **takes its children as a
function**:

```tsx
<Theme.Provider value="dark">
  {() => <Panel>Dark, without a prop.</Panel>}
</Theme.Provider>
```

React renders the tree after building it, so a provider there runs before its
children. This runtime renders as it goes, so `<Panel>` written plainly would
render before the provider had set its value; the function holds it back.
Plain children are a type error. [`05-rendering.md`](05-rendering.md), "Context",
has the detail.

## A layout

```tsx
// components/shared/layout.tsx
import { type Child, SeoHead, usePage } from '@crombolo/crombolo'
import { Breadcrumbs } from './breadcrumbs.tsx'
import { Theme } from './theme.tsx'

interface LayoutProps {
  theme?: 'light' | 'dark'
  children: () => Child
}

export function Layout({ theme = 'light', children }: LayoutProps) {
  return (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <SeoHead {...usePage()} />
        <link rel="stylesheet" href="/css/site.css" />
      </head>
      <body class={`theme-${theme}`}>
        <Breadcrumbs />
        <Theme.Provider value={theme}>{children}</Theme.Provider>
      </body>
    </html>
  )
}
```

The layout is a component the page imports. It takes its children as a function
because it provides a context to them, as any provider must. A page that starts
with `<html>` gets `<!DOCTYPE html>` in front of it. A template can instead name
its layout with `export const layout = 'shared/site'`; that layout renders
around the finished page, so it cannot provide a context to it.

## The page

```tsx
// components/showcasePage.tsx
import type { PageProps } from '@crombolo/crombolo'
import type { ShowcasePage as Page } from '../schema/content-types'
import { ArrowIcon } from './shared/arrow-icon.tsx'
import { CardList } from './shared/card-list.tsx'
import { Hero } from './shared/hero.tsx'
import { Layout } from './shared/layout.tsx'
import { NewsletterForm } from './shared/newsletter-form.tsx'
import { Panel } from './shared/theme.tsx'
import { UpcomingEvents } from './shared/upcoming-events.tsx'

export default function ShowcasePage({ model, nav }: PageProps<Page>) {
  return (
    <Layout theme="dark">
      {() => (
        <main>
          <Hero>
            <h1>{model.value('title')}</h1>
            <a href="#events">
              Upcoming events <ArrowIcon />
            </a>
          </Hero>
          <Panel>{model.html('body')}</Panel>
          <CardList pages={nav.children(model)} />
          <section id="events">
            <UpcomingEvents feedUrl={model.text('feedUrl')} />
          </section>
          <NewsletterForm topics={['News', 'Events']} />
        </main>
      )}
    </Layout>
  )
}
```

`PageProps<Page>` types the page by the interface `crombolo generate` writes for
its content type, so `model.value('title')` is a `string` and a misspelt alias
is a type error.

## Interactive parts

A page is static HTML: nothing in it runs in the browser, so an `onClick` is
refused. Interactive code is a script of its own, bundled for the browser and
mounted on an element the page renders:

```tsx
<div id="price-calculator" data-props={JSON.stringify({ currency: 'AUD' })} />
<script type="module" src="/scripts/price-calculator.js" />
```

```ts
// client/price-calculator.ts, bundled with: bun build client/price-calculator.ts --outdir scripts
const mount = document.getElementById('price-calculator')
if (mount) {
  const { currency } = JSON.parse(mount.dataset.props ?? '{}')
  // ...render into `mount`, with any library or none
}
```

## When something is refused

| Written | Why it fails | Instead |
| --- | --- | --- |
| `onClick={…}`, or any function as an attribute | nothing in the browser runs it | a script mounted on the element |
| `<Theme.Provider value="x"><Child /></Theme.Provider>` | `<Child />` rendered before the value was set | `{() => <Child />}` |
| `{someObject}` as a child | it has no text of its own | render its fields, or `JSON.stringify` it |
| a React component imported from a library | it needs React itself | a script mounted on the element |
| `usePage()` at the top of a module | there is no page outside a render | call it inside the component |
| `<select value="x">` with its options from another component | they were written before the select could mark them | `selected` on the option |
