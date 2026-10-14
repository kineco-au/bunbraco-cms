# Search & sharing

How a page appears in search results and when it is shared, built into core. In
Umbraco this comes from a community package (SeoToolkit); here it ships with the
CMS and is on by default, because nearly every site needs it and the parts only
work together: the head tags, the sitemap and the editor's preview all read the
same fields through the same fallbacks.

What is included:

| Part | Where |
| --- | --- |
| Per-page fields: title, description, sharing image, preferred address, hide from search engines, hide from sitemap | the `seoFields` composition, shipped as a system content type |
| `<SeoHead>`: `<title>`, description, canonical, Open Graph, Twitter card, `hreflang` alternates, `noindex` | `@crombolo/render`, exported by `@crombolo/crombolo` |
| `/sitemap.xml` and `/robots.txt` | the server, before the renderer |
| Site-wide defaults: site name, title suffix, sharing image, robots rules, indexable, sitemap on/off | `crombolo.config.ts`, overridable in Settings → Search & sharing |
| A chosen page for addresses nothing answers, served with a 404 | the same settings |
| `umbracoUrlAlias`, `umbracoRedirect`, `umbracoNaviHide` | the published cache and navigation |
| The editor's view of how a page will look in search results | a workspace view on every page whose type composes `seoFields` |

Not included, deliberately: a script manager (a template slot does the job
without letting editors inject script), a site audit crawler, and AI-written
meta. Redirect management is the `simple-redirects` bundle
([`bundles.md`](bundles.md)).

## The `seoFields` composition

A site opts a type in by composing it:

```toml
[content-type]
alias = "contentPage"
compositions = ["seoFields"]
```

No file is needed for `seoFields` itself. Like the Folder, Image and File media
types ([`schema-as-code.md`](schema-as-code.md)) it is a **system type**:
shipped with the CMS, ensured at every boot by its fixed key, exempt from schema
retirement, not deletable, alias fixed.

Unlike them, a site may **extend** it. Adding a field in the backoffice writes
`schema/content-types/seo-fields.toml`, and a hand-written file with the same
alias and key does the same. What a site may not do is remove, re-alias or
retype a field the CMS ships with — `<SeoHead>` and the sitemap read those by
alias. The validator refuses such a file and names the field; the Management API
refuses the same change from the backoffice. Labels, descriptions, order and
culture variance may change. `crombolo schema export` writes the file only once
it differs from what ships.

| Field | Alias | Data type |
| --- | --- | --- |
| Search title | `seoTitle` | `textstring` |
| Search description | `seoDescription` | `textarea` |
| Sharing image | `seoImage` | `imageMediaPicker` |
| Preferred address | `seoCanonical` | `textstring` |
| Hide from search engines | `seoNoindex` | `trueFalse` |
| Hide from sitemap | `seoSitemapHide` | `trueFalse` |

The fields ship **invariant**. A value is stored by its property's own variance,
not masked by the composing type's, so a culture-varying field on a type that does
not vary would split one page's value by language. A multilingual site turns
variance on in its own `seo-fields.toml`, and the validator then requires every
type composing it to vary by culture as well.

## Fallbacks

`effectiveMeta(content, context, overrides)` is the one place they live. Each
value carries where it came from — `page`, `template`, `site`, `name` or `none` —
which is what the editor's view shows.

| Value | Order |
| --- | --- |
| Title | the page's `seoTitle` → the template's `title` → the page name; then the template's `titleSuffix`, else the site's (`null` from the template drops it) |
| Description | the page → the template → omitted |
| Sharing image | the page → the template → the site's default |
| Preferred address | the page → the template → the page's own URL — never an alias |
| `noindex` | the site not indexable → the page → the template |

A template supplies its fallbacks as props:

```tsx
import { type PageProps, SeoHead } from '@crombolo/crombolo'

export default function Layout(props: PageProps & { children?: Child }) {
  return (
    <html>
      <head>
        <SeoHead {...props} description={props.model.text('strapline')} />
      </head>
      …
```

To make addresses absolute, `PageProps` carries `request` (`origin`, `url`), a
`urls` helper (`absolute`, `alternates`) and `seo`, the site-wide values. The
origin honours `X-Forwarded-Proto` and `X-Forwarded-Host`, so a site behind a
proxy writes the address visitors use.

Language versions are offered as `hreflang` only when a page has two or more with
an address, with the default language's as `x-default`.

## Sitemap and robots

`/sitemap.xml` lists, for the requesting hostname, every published page that has
a template, has an address in the culture, is not hidden from the sitemap and is
not protected. A request on a hostname bound to a document lists that hostname's
pages; any other request lists the pages with no hostname. Each entry carries
`lastmod` and its language versions as `xhtml:link` alternates. One file holds
every URL; splitting past 50,000 into an index is a follow-up.

`/robots.txt` is the configured rules plus the sitemap's address. A site that is
not indexable answers `Disallow: /` instead, serves no sitemap, and every page
gets `noindex` — the switch for a staging copy. Neither route exists on an `api`
node, which serves no public site.

## Site settings

Each setting resolves field by field: a value saved in Settings → Search &
sharing, then `seo` in `crombolo.config.ts` (or its environment variable), then
the default. Saved values are stored as JSON in `key_value` under
`Crombolo.Seo.Settings`; clearing one in the backoffice falls back to the config
again. A node trusts what it read for ten seconds, so a save on one node reaches
the others within that.

```ts
export default defineConfig({
  seo: {
    titleSuffix: ' | Acme',
    defaultImage: '/media/share.png',
    notFoundPage: [
      { document: '…', host: 'acme.dk' },
      { document: '…' },
    ],
  },
})
```

The settings and the preview are not part of the vendored contract, so they are
the framework's own endpoints at `<backoffice>/crombolo/api/seo/`: `settings`
(GET and PUT, Settings section) and `preview?document=&culture=` (GET, any
editor). The preview reads the last **saved** version, published or not.

## The not-found page

After route resolution, the alias finder and the redirect lookup have all failed,
the chosen page renders with status 404. With rules per hostname and language,
the most specific match wins: hostname and language, then either, then neither. A
page that fails to render leaves the plain `Not Found`, rather than a second
error.

## Reserved properties

These work on any type that declares them, as in Umbraco; none is part of
`seoFields`.

| Alias | Effect |
| --- | --- |
| `umbracoUrlAlias` | comma-separated extra addresses, relative to the site root or to the hostname that roots the page. Claimed after every real route, so an alias never takes an address a page already answers on; the canonical stays the real URL |
| `umbracoRedirect` | a content picker: the page answers `302` to the picked page's address, keeping the query string. One hop |
| `umbracoNaviHide` | `content.isVisible` is false, and `nav.children(page, { visibleOnly: true })` and `nav.root({ visibleOnly: true })` leave the page out. Plain `children()` is unchanged |
