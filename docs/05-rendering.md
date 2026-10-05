# Rendering

Umbraco renders with Razor. We render with **TSX executed by Bun**. The goal is
not syntactic similarity but the same *contract*: the same model, the same
fallback semantics, the same layout chain, the same routing.

## Templates on disk

A template is a `template` row (`alias`, plus a `node` row for name and parent)
paired with a file. Umbraco uses `~/Views/{alias}.cshtml`; we use
`apps/site/Views/{alias}.tsx`. The alias determines the filename, exactly as
upstream.

The **layout chain lives in the file, not the database**. Umbraco parses
`Layout = "master.cshtml";` back out of the Razor source with a regex and treats
it as the source of truth, keeping `node.parent_id` in sync. We do the same with
an exported constant:

```tsx
export const layout = 'master'
export default function HomePage({ model }: PageProps) { … }
```

The template editor is Umbraco's and still speaks Razor. A new template
starts as its Razor scaffold, and picking a layout prepends
`@{ Layout = "master.cshtml"; }`. Removing a layout from a view with no such
block sends `"undefined.cshtml"`. On save the server translates, in
`fromBackofficeTemplate`: the untouched scaffold becomes the TSX starter, and
a layout block becomes the view's `export const layout`, replacing any it had.
Anything else is saved as written.

("Master template" was renamed **layout template** in Umbraco 18;
`MasterTemplateAlias` is obsolete and scheduled for removal in v20, so we use
"layout" throughout.)

Which template a document renders comes from `document_version.template_id` —
*per version*, so a draft and its published version can legitimately differ —
constrained by `content_type_template`. `?altTemplate=` overrides it.

Partials resolve from an ordered list, mirroring
`RenderRazorViewEngineOptionsSetup`:

```
Views/{name}.tsx    Views/Shared/{name}.tsx    Views/Partials/{name}.tsx
```

### Checking them before a visitor does

A view is compiled when a request renders it, so one that does not compile is a
500 that waits to be found. `bunbraco views check` brings that forward: every
`.tsx` under `Views/` is transpiled — which gives the line a syntax error is on
— and then imported, which is what a render does, so an import that does not
resolve is caught as well. It also reports a template a document type declares
with no file behind it, the `noTemplate` 404 seen from the other side.

Types are a separate question, because they need the compiler and a site may not
have one: when `typescript` is installed the command also runs `tsc --noEmit`
over the site, and when it is not it says so rather than quietly checking less.

Only the top level of `Views/` holds templates, which is what `templateAliasesIn`
scans and what the schema validator checks against. A view nobody declares is
left alone — a shared component is a legitimate file, and it belongs in a
subdirectory, where nothing will mistake it for a template.

A view may only import what the tree contains. A relative import that climbs out
of `Views/` resolves on disk and fails the moment the view is rendered, because
it is rendered from a snapshot of the tree and nothing above it; `views check`
refuses one, where the message can explain itself.

## A changed view, without a restart

A view is a module, and the module registry behind `import()` is keyed on the
resolved path, has no eviction, and ignores a cache-busting query on Bun. Even
where the query works — Node does honour it — the graph *beneath* a re-imported
file stays pinned, so re-reading a template would still render the layout it
first imported. Clearing any cache this codebase owns changes none of it.

Only a new path is read fresh, so each node renders from a content-addressed copy
of the tree (`render/snapshots.ts`):

    alias  →  <viewsCacheDir>/<hash>/<alias>.tsx

The hash covers the whole tree, because a template's behaviour is its import
graph: `homePage.tsx` can be byte-identical while its layout changed. Structure
is preserved, so relative imports resolve inside the snapshot and no request can
pair a new template with an old layout.

`viewsDir` stays the truth — the template editor, `listViews` and `views check`
all read it, and a snapshot is only ever an import target. Render errors are
mapped back through `Renderer.inSource`, so a stack trace names the file somebody
can open rather than the generation it was imported from.

Two things notice a change. A template saved in the backoffice is snapshot before
the save returns and announced as a `views` cache instruction carrying the hash it
produced; an announced change skips the coalescing floor, because the floor exists
to absorb a flapping sync and a deliberate save is not one. Everything else — a
deploy, a mounted bucket syncing, a file written in the container — is caught by
a periodic re-hash on the render path, behind a TTL and single-flight, with the
current snapshot serving while it runs.

Because the name is the content, an unchanged tree means no copy and no
re-import, and a reverted change returns to a generation already loaded. What
bounds it is the generation limit: every generation stays in the runtime's
registry until the process exits, so at the limit a node freezes — keeping the
views it has, refusing newer ones, and saying so in its log and on `/health`,
which stays `ok` so a stale template cannot drain the whole set. See the README's
"How a changed view reaches a running node" for the settings.


**The template editor writes TSX.** Umbraco's client hard-codes a Razor
scaffold for a new template and writes a Razor `Layout = "x.cshtml"` block when
a master template is chosen. Our backoffice plugin
(`backoffice-host/plugin/tsx-editors.js`, a `backofficeEntryPoint`)
patches the two methods that write Razor — the template repository's scaffold
and the workspace's master-template update — on Umbraco's own classes. It does
not re-register the extensions: changing the registry while the backoffice is
rendering makes open sections re-evaluate their extensions, and a route set up
in that window throws inside Umbraco's code. So a new template starts as a TSX view and a master becomes
`export const layout = '<alias>'`. The server still translates Razor it
receives from anything else. `GET /template/{id}` answers the master as both
`layoutTemplate`, which the client reads, and the contract's older
`masterTemplate`.

### Emitting markup

Values escape by default: `renderChild` runs everything but `RawHtml` through
`escapeHtml`, so `{model.text('title')}` cannot inject. Markup reaches the page two
ways.

`model.html('alias')` returns `RawHtml` and is the short route — rich text hands a
template its markup, so this is what a body field wants.

The **`setInnerHTML` attribute** covers markup from anywhere else, and takes React's
`{ __html }` shape with one addition:

```tsx
<div setInnerHTML={{ __html: model.text('bodyText'), dangerously: true }} />
```

Without `dangerously` the content is **escaped**. That is the deliberate difference
from React's `dangerouslySetInnerHTML`, which is always verbatim and whose only
guard is how alarming the name is — a guard that stops working the moment the
attribute is copied from one template to another. Here the decision lives in the
value, so forgetting it fails closed. The attribute never appears in the output, and
a void element has no content to set, so it is ignored there. Pinned by
`tests/documents.test.ts` "setInnerHTML emits markup verbatim only when told to".

## The model a template sees

Umbraco's `IPublishedContent` is deliberately tiny, and notably has **no `Parent`
or `Children`** — tree navigation moved out to separate services. We keep that
split; it is what makes the published cache cheap.

```ts
interface PublishedElement {
  key: string; id: number; name: string; contentType: { alias: string }
  sortOrder: number; createDate: Date; updateDate: Date
  creatorId: number; writerId: number
  cultures: Record<string, PublishedCultureInfo>
  properties: PublishedProperty[]
  getProperty(alias: string): PublishedProperty | undefined
  isDraft(culture?: string): boolean
  isPublished(culture?: string): boolean
}
interface PublishedContent extends PublishedElement {
  urlSegment?: string; templateId?: number; level: number; path: string
}
```

Navigation and URLs are injected services, not properties:
`nav.parent(content)`, `nav.children(content)`, `nav.ancestors(content)`,
`nav.descendants(content)` — each filtering by published status and culture — and
`urls.get(content, { mode, culture })`.

Beside the model, a template receives the **signed-in member**, or `undefined` for
an anonymous visitor. `roles` are member group *names*, which is the currency
public-access rules deal in, so a template can ask the same question a rule does:

```tsx
export default function Page({ model, member }: PageProps) {
  if (!member) return <SignInForm returnUrl={model.url} />
  return member.roles.includes('Subscribers') ? <Full model={model} /> : <Teaser model={model} />
}
```

### `value()` — the ergonomic core

`@Model.Value("alias")` is the single most-used API in an Umbraco view, and its
behaviour is more subtle than it looks:

```ts
model.value(alias, { culture?, segment?, fallback?, default? })
```

1. get the property; if it has a value for `(culture, segment)`, return it
2. otherwise run the fallback strategy
3. otherwise return the property's raw value anyway

Fallback strategies, from `Fallback.cs`: `None`, `DefaultValue`, `Language`
(follow `language.fallback_language_id` up the chain), `Ancestors`.

**Culture is ambient.** `model.value('title')` with no culture argument returns
the *current request's* culture value, resolved from a per-request variation
context. Reproducing this is what makes variant templates readable; without it
every call site has to thread a culture through.

### Value conversion

Umbraco converts in three memoised stages (source → intermediate → object),
with cache levels per converter. Here a value is converted when a template
reads it (`convertValue`, by editor alias, with the data type's
configuration), against the published snapshot; see *Property values* below
for what each editor yields. Memoising per request, which Umbraco does for
block elements, is left until profiling asks for it.

## Request pipeline

Mirrors `PublishedRouter` → `UmbracoRouteValuesFactory`:

1. **Resolve the domain** for the request URI → sets the request's domain and culture
2. **Run content finders in order** until one sets content:
   by page-id query → by URL → by key/id path → by URL alias → by redirect →
   last chance: the configured 404
3. **Pick the template** → look for a route hijack: a controller whose name equals
   `content.contentType.alias` (Umbraco's "route hijacking"). In our stack the
   equivalent is an optional `apps/site/Controllers/{alias}.ts` exporting a
   handler that can run logic and choose a view.
4. **No template and no hijack ⇒ 404**, re-run through the last-chance finders
5. **Enforce public access** (`public_access` + `public_access_rule`) before rendering

Step 5, in detail, because it is the one that surprises people: a protected page
is **rewritten**, not redirected. The visitor keeps the URL they asked for and the
login or error page renders at it, with a 200 — which is what Umbraco's
`PublicAccessRequestHandler` does. The nearest protected ancestor governs,
resolved against `node.path` rather than by walking parents. A login or error page
that sits inside the branch it serves renders as itself, or the substitution would
never terminate; beyond that the renderer caps substitutions at 8, as Umbraco
does, and a rule pointing at a page that no longer exists is a 404 rather than an
open door.

The decision itself is the server's, not the renderer's: `Renderer.render` takes
an optional `access(content)` hook and a `member`, so the policy lives where the
database is and the renderer keeps knowing only about templates and layouts.
Preview is exempt — only a signed-in editor reaches it.

### Redirects, at step 2's end

Umbraco's redirect lookup is a *content finder*, which is to say it runs only
after every other finder has failed. Ours sits in the same place — the 404 branch
of `renderSite` asks `PublishedCache.redirect(host, pathname)` — with the same
consequence: a redirect can never shadow a page that exists. The rules live in the
cache's snapshot, so a publish, a cache instruction from another node, or a
redirect being written drops them together with everything else derived from the
published tree.

Matching order within a request is configured rules, in the order the site
declares them, then the rules an administrator wrote in the backoffice
(`@bunbraco/simple-redirects`, [`17-bundles.md`](17-bundles.md)), then tracked
rules, newest first. A rule scoped to a hostname is
tried only against a request that hostname roots, and its pattern is the route
*below* the rooting document, keyed by that document's key rather than by the
hostname's name — so renaming `example.com` to `example.co.uk` leaves every
redirect below it working. Umbraco keys the same thing by the domain root's node
id, for the same reason.

A rule naming a document resolves through the cache at request time. That gives
two behaviours worth stating: two successive renames leave the oldest URL pointing
at wherever the page is *now* rather than chaining 301s, and a rule whose document
has been unpublished or deleted simply does not match, so the visitor gets the 404
instead of being sent somewhere that is no longer there.

The 301 carries the request's query string and is sent with `no-store,
must-revalidate`. Umbraco does both, the second deliberately: browsers cache 301s
hard enough that renaming a page and renaming it back would otherwise leave
anyone who saw the first answer stuck on the redirect.

**The tracker** captures the routes a branch answers on before a publish or a
move, compares them after, and records a 301 for each one that changed. It has to
be a before-and-after pair because a route is derived from names and tree position
and cannot be reconstructed afterwards — which is exactly why Umbraco uses a
notification pair (`ContentPublishing`/`ContentPublished`,
`ContentMoving`/`ContentMoved`) rather than a single hook. Recycle-bin moves are
excluded, as upstream. See `packages/server/src/redirects.ts`.

**A rule has one of three sources**, and the column is what orders them:
`config` for one the site declares in code, `manual` for one an administrator
added through the redirects bundle, `tracked` for one the tracker recorded. Only
`manual` is editable in the backoffice — the file owns a configured rule and the
tracker owns a tracked one, and the API says so rather than letting a change be
undone at the next boot or publish.

Sorting is tracked too, which Umbraco does not do. It normally changes no URL — a
segment comes from the name — but `HideTopLevelNodeFromPath` makes the *first* root
page `/` and the others `/<segment>`, so re-ordering the roots moves them. The
capture is by parent rather than by node there, because the write is on the parent
and the URLs that move belong to its children.

## URLs

Segment generation: the `umbracoUrlName` property if set, else the published name,
run through a URL-segment helper (diacritic folding, lowercase, `-` separators,
culture-aware). Pluggable, as upstream.

Resolution walks the tree segment by segment, **checking that each ancestor is
published in the requested culture** — an unpublished ancestor breaks the route.
URLs follow Umbraco's default `HideTopLevelNodeFromPath = true`: the first root
page (by sort order) is `/`, any other root page is `/<segment>`, and no root's
segment appears in the URLs below it, so Home's child is `/about-us`, not
`/home/about-us`. Where two pages claim one URL, the shallower and then the
first-sorted wins, as Umbraco resolves it. There is no switch to show the top
level yet. Still to port: RTL segment order.

## Property values

Structured editors hand the client an object, not text. Their values are stored
as JSON text and parsed on the way back out, by editor alias
(`JSON_VALUE_EDITORS` in `@bunbraco/core`), as Umbraco's value editors do.
Rich text is always `{ markup, blocks }` for the editor, including a legacy plain
HTML string, and just its markup for a template, so `model.html('bodyText')`
renders it. An upload is stored as its path and edited as `{ src }`; true/false
reads back as a boolean; a date is the wall-clock time the picker sent. An element
picker stores a bare `Guid[]` — keys, not the `umb://…` udis a content picker
stores — which is why `Umbraco.ElementPicker` is in `JSON_VALUE_EDITORS`.

What a template receives is converted on read, through a context the published
cache supplies (`@bunbraco/render` `values.ts` and `media.ts`):

| Editor                  | `model.value()`                                                                                             |
| ----------------------- | ----------------------------------------------------------------------------------------------------------- |
| Content Picker          | the published page, or null                                                                                 |
| Multinode Treepicker    | the published pages, in order                                                                               |
| Element Picker          | `PublishedElement[]`, always a list, dropping any not published in the page's culture                       |
| Multi URL Picker        | `Link[]`, with page and media URLs resolved                                                                 |
| Block List / Block Grid | items with `content` and `settings` as `PublishedElement`s (same `value()`); grid items add spans and areas |
| Media Picker            | `MediaWithCrops`, one or a list as the data type says; `model.media(alias)` always lists                    |
| Image Cropper           | `ImageCropperValue` (`src`, `crops`, `focalPoint`, `cropUrl()`)                                             |
| Rich text               | the markup, with `/{localLink:…}` links resolved (`#` when gone)                                            |

References to anything unpublished or deleted are dropped. `bunbraco
generate` types all of these, down to a block editor's element types.

Umbraco denormalises segments into `document_url` / `document_url_alias` for
throughput. We defer both and walk the tree; the tables are a pure optimisation
with a rebuild signature, and can be added when profiling asks.

Outbound URL generation goes through a provider chain with modes
`Default | Relative | Absolute | Auto`, and cultures that are not published
resolve to an explicit "unroutable" marker rather than a broken link.

### Domains

Culture and hostnames live in `domain` (migration 010): hostnames, with an
optional path prefix, that root the site at a document in a culture, plus an
optional wildcard (`*<node id>`) that only sets the culture of a branch. A
request takes the longest hostname and prefix that match its host; the rest of
its path routes below that document, which is `/` there. A page under a
hostname reports a protocol-relative URL (`//example.com/about`). A host with
no domain routes as above. The request's culture reaches the view as
`culture`.

#### Where they come from: `domains.toml`

A hostname is the one piece of site metadata that differs in every environment,
so it is neither content nor schema. A site may keep `domains.toml` beside
`bunbraco.config.ts`:

```toml
[[domain]]
node = "/"
host = "${SITE_HOST}"

[[domain]]
node = "/Home/French"
host = "fr.harbourstone.example"
culture = "fr-FR"
```

`node` is a content path, a node uuid, or `/` for the site's root page — refused
rather than guessed at when more than one page sits at the root. `${VAR}` is
read from the environment when the file is applied, which is how one committed
file serves development, staging and production; a variable that is not set
there leaves that hostname unbound and says so, rather than binding a
half-built name that answers for nobody. A culture may be left out, and the
hostname then serves the site's default one.

**The file is the truth.** Boot converges the `domain` table onto it, so
deleting an entry unbinds that hostname — the same bargain
`syncConfiguredRedirects` makes for rules declared in the config. Each entry
states a page's *whole* assignment, so two entries naming the same page in
different words (`/` and `/Home`) are refused rather than silently replacing
one another. A site with no `domains.toml` is left alone entirely: nothing to
converge onto means the backoffice stays the only way, as it was before.

`bunbraco domains` prints what the file declares, what each `${VAR}` comes to
here, and what is actually bound. `domains set` and `domains clear` write the
file *and* apply it, keeping the file they replaced so `domains undo` puts it
back — a wrong hostname takes a site off the air, since a root page with one
answers on nothing else. `domains apply` is what a deploy step runs; it is what
boot does.

A save in the backoffice's own dialog writes the file too, so the next boot does
not undo it, and says so in the notification it returns. Only that page's
entries are rewritten: regenerating the file from the database would resolve
every `${VAR}` in it into whatever this machine happens to have, baking one
environment's hostnames into a file meant for all of them.

### Cultures

A page that varies by culture routes and renders per culture. A hostname
serves its own culture: `da.example.com` → the Danish view, where a page's
name, URL segment (its culture's `umbracoUrlName`, else its culture's name)
and URL are Danish, and a page not published in Danish does not exist. Without
a hostname, routes are the default language's; a varying page's URL in another
culture with no hostname for it is `#`, Umbraco's unroutable marker. Invariant
pages appear in every culture. `GetDocumentUrls` lists one URL per published
culture.

`fallback: 'language'` walks the culture's `fallbackIsoCode` chain, stopping at
a cycle. The dictionary follows the same chain: templates receive
`dictionary(key)`, the item's translation in the page's culture, then its
fallbacks, else `''` (Umbraco's `GetDictionaryValue`).

## The published cache

Published only — drafts are never cached. Invalidated through the notification
bus, from *inside* the repository's unit of work (upstream raises
`ContentRefreshNotification` there, which is what makes cache updates
transactional with the write).

Umbraco runs three tiers: an in-process converted-object cache, a hybrid
memory/distributed cache of serialised nodes, and the `content_cache` table.
**We implement tier 1 only** and read through the canonical join in
`02-data-model.md`. A single Bun process does not need the rest, and the table is
rebuildable at any time.

The cache holds one view per language — a model for each page in each culture
it is published in — so the ambient culture, pickers, links and `nav` all
resolve within the culture of the page asking. Each culture's values are read
as of the publish that culture went live with (see `02-data-model.md`), so a
culture published later never exposes another culture's newer draft.

### Published elements

Elements (the Library section, WP-6.11) are publishable content with no URL, so
nothing routes to one: a template reaches an element only because a property points
at it. A published element **is** readable by a template, held in this cache, so
publishing an element means something a visitor can see and unpublishing one drops
it from the pages that picked it. What follows is Umbraco's own design, read from
its source rather than invented.

**The editor is a first-class one, not a repurposed picker.** `Umbraco.ElementPicker`
(UI `Umb.PropertyEditorUi.ElementPicker`), with its own tree picker data source and
its own configuration — `ignoreUserStartNodes`, a min/max `ValidationLimit`,
`AllowedContentTypeIds`, a start node, and a folder-only mode. Umbraco seeds **no**
built-in data type for it: the schema ships and a site makes its own data type, so
`DEFAULT_DATA_TYPES` needs no new entry.

**The stored value is a plain JSON array of keys** — `Guid[]`, not
`umb://element/…` udis. Simpler than the content picker, where `values.ts` has to
match both spellings.

**Resolution is by key against a cache of its own.** Umbraco reads
`IPublishedElementCache.GetById(preview, key)` at `PropertyCacheLevel.Elements`,
separate from the content cache, and the converter's value type is
`IEnumerable<IPublishedElement>` — always a collection, even where the configuration
allows one pick. Culture filtering happens **on read, not on store**: an element not
published in the ambient culture is dropped from the array, which is what the content
and media pickers here already do for unpublished targets.

**How it is built here.** Culture filtering falls out of the structure rather than
needing a filter: elements live in the **culture views**, not in a single global map
like media, so `elements` on a view holds only what that culture can see. An
invariant element is in every view; a varying one only in the cultures it is
published in. The context a culture builds resolves `element(key)` against its own
view, so a picker inside an element resolves in the same culture as the page that
asked.

- `loadElements()` on `PublishedContentSource` feeds it. It reuses the same query
  that builds the content cache: `DocumentRepository.loadPublished()` is keyed on
  the repository's own object type, so `kind: 'element'` returns published elements
  with no second query to maintain.
- `values.ts` converts `Umbraco.ElementPicker` by resolving each key through the
  context and dropping the misses — an element unpublished, trashed or deleted
  simply is not in the view, so no gap is left in the array.
- Invalidation was already there: the element port appends a
  `{ elements: true }` cache instruction on every write, which drops the snapshot on
  this node and on every other one through the poll.
- `bunbraco generate` narrows a picked element to its type. `allowedContentTypes` is
  a comma-separated list of element type keys, as Umbraco's
  `AllowedContentTypeKeysParser` reads it, so a picker allowing one type generates
  `Array<TypedElement<Quote>>` and one allowing two generates
  `Array<TypedElement<Quote> | TypedElement<Aside>>`. `Array<…>` rather than `…[]`
  deliberately: a union written as `A | B[]` binds as `A | (B[])`.

A picker always yields a collection, as Umbraco's converter does, even where its
configuration allows one pick — so a template writes `model.value('hero')[0]` for a
single. Pinned by `tests/elements.test.ts` "published elements in a template" and
"`bunbraco generate` for the element picker".

Cache entries must be tagged by content type (`ct:{id}`) so a content-type change
can evict selectively. Content-type changes split into *rebuild* (alias or
variation changed — stored values are now invalid) versus *evict only* (name,
icon, description, added property).

## Preview

Asking for a document's preview URL sets the `UMB_PREVIEW` cookie and returns
Umbraco's `preview?id=…`, the backoffice's own preview app, which frames
`/<document key>`. With the cookie and a signed-in editor (the backoffice's
access-token cookie), the front end renders the draft, for routed URLs too;
without an editor the cookie changes nothing. Saving a document tells an open
preview to reload over `/umbraco/PreviewHub` (`refreshed`).
`DELETE /umbraco/management/api/v1/preview` ends it.

## Media and imaging

Media items are documents of the media object type, never published. A file
is uploaded as a temporary file, then placed when a value that names it is
saved, at `<8 hex>/<safe name>` in the site's **media store**, and served at
`/media/…`.

Where those bytes live is one interface, `MediaStore`: the file system by default
(`BUNBRACO_MEDIA_DIR`, default `media`), or an S3 bucket or Azure container — see
the README's *Media storage*. Nothing here depends on which: the database holds
the path a value names, and serving either streams the bytes or, for a store that
returns a `publicUrl`, redirects the browser to a CDN or a presigned URL.

A `/media/…` URL with a query is an imaging request in the vocabulary
Umbraco's ImageSharp URL generator writes: `width`, `height`, `rmode` (crop,
max, stretch, pad, boxpad, min), `rxy` (focal point), `cc` (crop coordinates
as fractions trimmed from each edge), `format`, `quality`. Each variant is
computed once and cached in the store under `.cache/`, keyed by the source's
etag — so replacing an original invalidates its crops with nothing tracking
that, and one node's work serves every node. Bun's `Image` decodes, resizes
and encodes; cropping and padding go through raw RGBA pixels via a small PNG
codec in `@bunbraco/server` `imaging.ts`.

## Views

A view is reached only through a document type's template alias, and it is
loaded when a request renders it — so a view that does not compile is a 500 that
waits for a visitor to find it. `views check` is that failure brought forward:

```bash
bunx bunbraco views check             # compile every view; report a template with no file
bunx bunbraco views list              # what is in Views/, and which type declares each
bunx bunbraco views new header --partial     # Views/Partials/header.tsx
bunx bunbraco assets list             # the stylesheets and scripts beside them
bunx bunbraco assets new stylesheet print.css
```

Every `.tsx` is transpiled and then imported, which is what a render does, so an
import that does not resolve is caught as well as a syntax error. Types need the
compiler: when the site has `typescript` installed — `bunbraco init` puts it in
`devDependencies` — it also runs `tsc --noEmit` over the site, and says so when
it cannot. Only the top level of `Views/` holds templates, so a shared component
belongs in a subdirectory, where the template scan never looks.

## Hostnames

Schema travels between environments; hostnames cannot, because they mean
something different in each one. A site may keep them in `domains.toml` beside
`bunbraco.config.ts`, with `${VAR}` read from the environment when it is
applied, so one committed file serves them all:

```toml
[[domain]]
node = "/"
host = "${SITE_HOST}"

[[domain]]
node = "/Home/French"
host = "fr.harbourstone.example"
culture = "fr-FR"
```

```bash
bunx bunbraco domains                 # what the file declares, and what is bound here
bunx bunbraco domains set / --host '${SITE_HOST}'      # writes the file, then applies it
bunx bunbraco domains set /Home/French --host fr.example=fr-FR
bunx bunbraco domains apply           # what a deploy step runs; what boot does
bunx bunbraco domains undo            # put back the file the last write replaced
```

The file is the truth: boot converges the `domain` table onto it, so deleting an
entry unbinds that hostname. A site with no `domains.toml` is left alone, and
the backoffice stays the only way — and on a site that has one, a save in the
backoffice writes the file too, so the next boot does not undo it.
`docs/05-rendering.md` has the routing rules.

## How a changed view reaches a running site

A view is a module, and `import()` caches modules in the runtime keyed on the
resolved path. There is no eviction; a cache-busting query works on Node but not
on Bun; and on every runtime the graph *beneath* a re-imported file stays pinned,
so re-reading `homePage.tsx` would still render the layout it first imported.
That is why a saved template cannot simply be read again.

Only a **new path** is read fresh. So the server renders from a content-addressed
copy of the tree:

```
<site>/.bunbraco/views/<hash>/homePage.tsx          ← imported
<site>/.bunbraco/views/<hash>/components/layout.tsx ← resolves inside the snapshot
```

The hash is of the whole tree, because a template's behaviour is its import
graph: `homePage.tsx` can be byte-identical while the layout it uses changed.
Structure is preserved, so a view's own relative imports resolve unchanged, and
no request can mix a new template with an old layout.

A change is noticed two ways. A template saved in the backoffice is snapshot
before the save returns. Anything else — a deploy, a file written in the
container — is caught by a periodic re-hash on the render path, behind a TTL,
single-flight, with the current snapshot serving while it runs. One render after a
change may still be the old generation; the next is not.

Because the name is the content, nothing is wasted: an unchanged tree yields the
same hash, so no copy and no re-import, and reverting a change returns to a
generation already loaded. It also takes the mount off the request path entirely
— the bucket is read when the tree changes, never per render.

| Setting | Default | Development |
| --- | --- | --- |
| `BUNBRACO_VIEWS_CACHE_DIR` | `<site>/.bunbraco/views` | same |
| `BUNBRACO_VIEWS_GATE_MS` — how often a node looks | 5,000 | 500 |
| `BUNBRACO_VIEWS_SWAP_MS` — floor between generations | 10,000 | 0 |
| `BUNBRACO_VIEWS_GENERATION_LIMIT` | 250 | 250 |
| `BUNBRACO_VIEWS_KEEP` — generations left on disk | 3 | all, until boot |

Three things to know before changing them:

- **The cache directory must sit inside the site**, for the `jsx-runtime` reason
  above, and outside `Views/`, or it would snapshot itself. Both are refused at
  boot, and `bunbraco status` reports the same check so a deploy learns first.
- **It is cache, and cleared at boot**, so it must not be anything you would mind
  losing — it is rebuilt from `Views/` in milliseconds. Compose keeps it on a
  tmpfs so it never reaches the bind mount, where `--watch` would see it.
- **Each generation stays in the runtime's registry until restart** — about 88 KB
  for a small tree. That is what the generation limit bounds: at the limit a node
  **freezes**, keeps serving the views it has, refuses newer ones and says so in
  its log and on `/health`. It stays `ok` deliberately: a runaway writer should not
  turn a stale template into an outage. Restarting clears it.
