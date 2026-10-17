---
title: Getting started
summary: Create a site, sign in to the back office, add a content type and a template, and publish your first page.
order: 1
---

A crombolo site is a small Bun project. Your templates are `.tsx` components, your content model is a folder of TOML files, and the site, the back office and the API run as one process on SQLite or Postgres.

## What you need

| | |
| --- | --- |
| **Bun** 1.3 or later | runs the site, the command line and your tests |
| **Postgres** | optional. A new site uses SQLite, which needs nothing installed |

There is no Node toolchain, no .NET SDK and no separate database server to set up for a first site.

```sh
curl -fsSL https://bun.sh/install | bash
```

## Create a site

Make an empty folder and scaffold a site in it:

```sh
mkdir my-site && cd my-site
bunx crombolo init --name "My Site"
bun install
bun start
```

`init` writes a handful of files:

| File | What it is |
| --- | --- |
| `package.json` | the site's dependencies, with `bun start` running `crombolo start` |
| `crombolo.config.ts` | the site's settings ([Configuration](/docs/guides/configuration/)) |
| `server.ts` | three lines that start the server |
| `schema/` | your content types, as TOML files ([Schema as code](/docs/guides/schema-as-code/)) |
| `components/` | your templates and the components they share |

Add `--postgres` to write a `.env` that points at a Postgres database instead of SQLite.

### Start from a template

A site with no content types shows a holding page with a link to the back office. To start with something on the page, scaffold a starter template instead:

```sh
bunx crombolo init --template list                # the templates there are
bunx crombolo init --template basic               # a home page type, a view and one page
bunx crombolo init --template starter             # a header, a footer and placeholder pages
bunx crombolo init --template demo/harbourstone   # a whole brochure site, content and all
```

A template brings its schema, components, styles and images, and its content as a bundle that `bun start` imports the first time it runs.

## Sign in

The first start creates the database, then prints where the site is and how to sign in:

```text
┌─────────────────────────────────────────────────────┐
│ Crombolo is running                                 │
│                                                     │
│   backoffice  http://localhost:8080/crombolo        │
│   site        http://localhost:8080/                │
│                                                     │
│   Sign in with                                      │
│     username  admin@crombolo.local                  │
│     password  3ojND8TcMF0KjfD3                      │
└─────────────────────────────────────────────────────┘
```

On your own machine a fresh password is printed on every start, so what you see is always true. Set `CROMBOLO_ADMIN_PASSWORD` to keep the same one, or run `crombolo start --keep-admin` to leave it alone. A production site never does this; see [Deploying](/docs/guides/deploying/).

If port 8080 is taken, start on another: `PORT=3000 bun start`.

## Add a content type

You can create content types in the back office, under **Settings**, and each one is saved as a file in `schema/`. Or write one from the command line:

```sh
bunx crombolo types new content-type article --at-root
bunx crombolo types add-property article summary --type textarea --mandatory
```

The first command writes `schema/content-types/article.toml` and a starting template at `components/article.tsx`, then applies the type to the database. The second adds a property to it.

## Write the template

Open `components/article.tsx`. A template is a function from props to JSX, rendered to HTML on the server:

```tsx
import type { PageProps } from '@crombolo/crombolo'
import type { Article } from '../schema/content-types'

export default function ArticlePage({ model }: PageProps<Article>) {
  return (
    <html lang="en">
      <body>
        <h1>{model.text('title')}</h1>
        <p>{model.text('summary')}</p>
      </body>
    </html>
  )
}
```

Run `bunx crombolo generate` to write `schema/content-types.d.ts`, an interface for each content type, so your editor completes property names and flags a misspelt one. Run it again whenever a type changes.

There is no React in the browser: no virtual DOM, no hydration, and nothing shipped to the visitor unless you add a script yourself. Components are plain functions called once per request, so there are no hooks or state. Save the file and refresh; a template change needs no restart.

## Publish a page

1. In the back office, go to **Content**, create an **Article**, fill in the title and summary, and **Save**.
2. **Publish** it. The first page at the root is the site's home page, so `http://localhost:8080/` now renders your template.
3. Edit it and save again. The site keeps serving the published version until you publish the change, and **Info → History** lets you roll back.

## Check before you ship

```sh
bunx crombolo components check   # compile and type-check every template
bunx crombolo types check --static   # validate schema/ without a database
```

Both exit with a non-zero code when they find a problem, so they drop straight into CI.

## Where next

- [Configuration](/docs/guides/configuration/): the settings file and the handful of settings you set first
- [Schema as code](/docs/guides/schema-as-code/): content types as files, and how they reach production
- [Deploying](/docs/guides/deploying/): running a site in production
- [The command line](/docs/reference/command-line/): every command and flag
