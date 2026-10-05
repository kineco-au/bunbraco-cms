# Running a site

What a deployed site needs beyond the code: where uploads live, how a URL that
moved keeps working, how schema travels, and what the security model is.

## Media storage

Where uploaded bytes live is one interface — `MediaStore` in
`packages/server/src/media-store.ts` — so a site can move its media library off
the local disk without anything above it changing. It has four verbs (`get`,
`put`, `delete`, `list`) plus an optional `publicUrl`, and that is all the media
library, the image processor and the temporary-upload flow use.

Three stores ship:

| Store                     | Helper                                       | Notes                                                                                                            |
| ------------------------- | -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| **File system** (default) | `fileSystemMediaStore(dir)`                  | files under `mediaDir`, exactly where Umbraco puts them                                                          |
| **S3**                    | `s3MediaStore({ bucket, … })`                | via Bun's own S3 client — no dependency; works with AWS, Cloudflare R2, DigitalOcean Spaces, MinIO, Backblaze B2 |
| **Azure Blob Storage**    | `azureMediaStore({ account, container, … })` | the REST API with Shared Key or SAS auth — no SDK dependency                                                     |

A site picks one in `bunbraco.config.ts`:

```ts
import { defineConfig, s3MediaStore } from "bunbraco";

export default defineConfig({
    mediaStore: s3MediaStore({
        bucket: "my-site-media",
        region: "ap-southeast-2",
    }),
});
```

…or leaves it to the environment, which is what a container deployment wants:

```sh
BUNBRACO_MEDIA_STORE=s3
BUNBRACO_MEDIA_S3_BUCKET=my-site-media
BUNBRACO_MEDIA_S3_REGION=ap-southeast-2
# BUNBRACO_MEDIA_S3_ENDPOINT=…  for R2, Spaces or MinIO
# BUNBRACO_MEDIA_S3_PREFIX=uploads
# BUNBRACO_MEDIA_S3_PUBLIC_URL=https://cdn.example.com   redirect browsers to a CDN
# BUNBRACO_MEDIA_S3_PRESIGN_SECONDS=300                  or to a signed bucket URL
```

```sh
BUNBRACO_MEDIA_STORE=azure
BUNBRACO_MEDIA_AZURE_ACCOUNT=mysite
BUNBRACO_MEDIA_AZURE_CONTAINER=media
BUNBRACO_MEDIA_AZURE_KEY=…          # or BUNBRACO_MEDIA_AZURE_SAS=?sv=…
```

Credentials left unset fall back to whatever the underlying client would find
anyway, so a machine with an instance role needs none configured. An
unrecognised `BUNBRACO_MEDIA_STORE` degrades to the file system rather than
losing the media library.

Three things follow from the interface rather than from any one store:

- **Serving.** By default this server streams the bytes, which keeps a bucket
  private; it streams from the local file when the store has one, so a
  disk-backed site still gets `sendfile`. A store that returns a `publicUrl`
  gets browsers redirected to it instead.
- **Image variants.** Crops and resizes are cached _in the store_, under
  `.cache/`, keyed by the source's etag — so a replaced original invalidates its
  crops with nothing tracking that, and one node's work serves every node.
- **Temporary uploads.** These go to the store too, under `.temp/`, so a
  load-balanced set can place an upload a different node received.

Writing another store is implementing those four verbs;
`tests/media-store.test.ts` drives the whole media library against one backed by
a `Map`, which is the check that the seam is real.

---

## Redirects

A URL that has worked keeps working. Three things feed one table, `redirect_url`,
and one matching pass: the URL tracker, the site's own code, and — with the
redirects bundle installed — an administrator.

**The URL tracker.** Renaming or moving a published page records a 301 from the
URL it answered on, for the page and every published descendant, per culture —
Umbraco's behaviour, including the parts that are easy to get wrong: a recycle-bin
move records nothing (there is no new URL to point at), a rename that is reverted
removes the rule that would otherwise redirect the live URL to itself, and the 301
is sent uncacheable on purpose, because browsers cache them hard enough that a
rename-and-rename-back would otherwise stick for anyone who saw the first answer.
A tracked rule names the _document_, so two successive renames leave the oldest
URL pointing at where the page is now rather than chaining redirects. Set
`trackRedirects: false` to turn it off, as Umbraco's `DisableRedirectUrlTracking`
does.

One case goes further than Umbraco: **re-ordering root pages**. Under
`HideTopLevelNodeFromPath` the first root is `/` and the others are `/<segment>`,
so sorting the roots moves them — and Umbraco's tracker listens only to publish
and move, which leaves that one silent. Sorting is tracked here for the same reason
renaming is.

**Redirects in code.** A site declares its own with `redirect()`, which Umbraco
has no equivalent for — its answer is a rewrite rule in front of the site:

```ts
import { defineConfig, redirect } from 'bunbraco'

export default defineConfig({
  redirects: [
    redirect('/contact-us', '/contact'),
    redirect('/old-blog/*', '/news/$1'), //     a subtree; $1 is the tail
    redirect('/*', 'https://new.example.com/$1'), // the whole site
    redirect(/^\/product\/(\d+)$/, '/products/$1'), // captures substitute
    redirect('/docs/*', 'https://docs.example.com/$1', { status: 302 }),
    redirect('/legacy', { document: 'a3f1…' }), // follows the page's renames
  ],
})
```

A target may be a path, an absolute URL, or `{ document }` — a document key,
resolved when the request arrives, so the redirect follows the page when someone
later renames or moves it, and stops matching if the page is unpublished rather
than sending visitors to a dead URL.

**Redirects in the backoffice.** `@bunbraco/bundle-redirects` adds a Redirects
screen under Settings → Advanced, which is what the third-party Umbraco redirect
packages add over Umbraco's own dashboard: creating and editing a rule, not only
listing and deleting the ones a rename recorded. It offers everything the matcher
supports, and the rules it writes sit between the two above in precedence —
configured rules first, then these, then tracked ones.

It is opt-in twice over. `bun add @bunbraco/bundle-redirects` puts the screen in
the backoffice, and the endpoints behind it answer only once the site imports the
bundle's server half:

```ts
import { redirects } from '@bunbraco/bundle-redirects'

export default defineConfig({
  bundles: [redirects()],
})
```

Only a rule added there can be changed there. A configured rule belongs to the
file — the next boot would put a deletion back — and a tracked one belongs to the
page that was renamed, so both are listed and both refuse to be edited.
[`17-bundles.md`](17-bundles.md) covers why that split exists.

Three consequences of how these are wired:

- **Page routing wins.** Redirects are matched only once route resolution has
  found nothing, so a rule can sit in config for years without ever hiding a live
  page. Declaring one for a URL that a page occupies is allowed and simply inert
  until the page goes.
- **The database follows the file.** Configured rules are synced into
  `redirect_url` at boot, so the backoffice lists everything in force in one
  place. They are marked as owned by the configuration and the API refuses to
  delete one (409) — the next boot would put it back.
- **Hostnames scope a tracked rule by document, not by name.** A rule recorded
  under a hostname stores the key of the document that hostname roots, so
  changing the hostname leaves every redirect below it working.

In the backoffice this is Umbraco's own **Redirect URL Management** dashboard in
the Content section, plus the redirects listed on each page's Info tab. The
tracker's on/off switch there is read-only, matching Umbraco, which deprecated
the endpoint in v17 and made it a no-op in favour of configuration.

## Source control from the backoffice

Optional, like everything else here. Configured, an editor can see what the
repository is missing and send it, without ever meeting git:

```ts
export default defineConfig({
  git: { provider: gitHub({ repository: 'kineco-au/site', token: process.env.GITHUB_TOKEN }) },
})
```

```
GET  <backoffice>/bunbraco/api/git/status    where it would send
GET  <backoffice>/bunbraco/api/git/diff      what the repository is missing
POST <backoffice>/bunbraco/api/git/commit    send it
```

A pull request by default — a schema change arriving as a PR is reviewable, one
arriving on `main` is not; `pullRequest: false` commits straight to the branch.

Over GitHub's REST API rather than a `git` binary, because the CMS image has no
git and should not grow one, and a shallow clone per diff to compare a handful of
TOML files would be absurd. The commit is built the long way — blobs, a tree, a
commit, then moving a ref — so the whole change lands as one commit, which is what
a reviewer wants, and a partly-applied change is not a state that can happen.
`GitProvider` is the seam; GitHub is the implementation that ships.

## Members and public access

Members are content nodes with a sign-in facet: `node` + `content` +
`content_version` + a `member` row, so member types, properties and versioning
are machinery that already exists. The backoffice manages them through the
contract; the front end signs them in through four endpoints of ours, since
Umbraco has no fixed URLs for this (a site writes a surface controller):

|                                  |                                                     |
| -------------------------------- | --------------------------------------------------- |
| `POST /umbraco/members/login`    | `username`, `password`, `rememberMe?`, `returnUrl?` |
| `POST /umbraco/members/logout`   |                                                     |
| `POST /umbraco/members/register` | off unless `allowMemberRegistration`                |
| `GET /umbraco/members/current`   | the signed-in member, or `401`                      |

A form post is answered with a redirect, a JSON post with JSON, so the same
endpoint serves a plain `<form>` in a template and a `fetch` from the page. A
`returnUrl` must be a local path, which closes the open redirect a login form
would otherwise be.

A session is a signed ticket in a cookie — no server-side session table, so a
load-balanced set needs only the shared signing key (generated once into
`key_value`). The ticket carries the member's security stamp and it is checked on
every request, so changing a password or locking an account ends every session it
had, immediately.

Public access protects a branch by member group or by named member. As Umbraco
does, a protected page is **rewritten** to its login or error page rather than
redirected, so the visitor keeps the URL they asked for; the nearest protected
ancestor governs, and a login page inside the branch it protects still renders.
A template receives the member as a prop:

```tsx
export default function Page({ model, member }) {
    return member ? (
        <Article model={model} />
    ) : (
        <SignInForm returnUrl={model.url} />
    );
}
```

## Security

The posture is Umbraco's where the contract sets it, and stricter where the
contract says nothing. What is worth knowing as an operator:

| Area                    |                                                                                                                                                                         |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Backoffice sessions     | Reference tokens, stored hashed, in `__Host-` HttpOnly cookies; PKCE is mandatory; a reused refresh token or a replayed code ends the whole session                       |
| `returnUrl`             | Reduced to a local path by `localReturnUrl`, server-side and again in the login page — resolved against an origin, so `/\host` and a tab-smuggled `//host` are caught too |
| Lockout                 | Checked before the password, so a locked account cannot be used to confirm which guess was the real one                                                                   |
| Plugin routes           | The endpoints outside the contract answer to the same authority as the operations beside them: Settings for git, schema import and the upgrade findings                    |
| List views              | `collection/document/{id}` and `collection/media` need Read on the parent, so a start node bounds them as it bounds the tree                                               |
| Media                   | Content types come from the file name, never from the uploader's header; served with `nosniff` and `Content-Security-Policy: sandbox`, which denies script to SVG and HTML  |
| Member endpoints        | Cross-site form posts are refused via fetch metadata, since these act on a cookie and have no antiforgery token; registration uses the configured type and a password policy |
| Request bodies          | Capped at 32 MiB (`BUNBRACO_MAX_REQUEST_BODY_MB`) rather than Bun's 128 MB default                                                                                        |
| Assistant               | Read-and-propose only; the transcript a browser returns is capped before it is billed; provider configuration is shown to Settings holders only                            |
| Proposed templates      | Scanned for the globals and the roads to `eval` — `Function`, `.constructor`, `import.meta` — behind human approval, which is the real gate                               |

Two things follow Umbraco rather than improving on it, deliberately, and are
worth a decision per site:

- **Rich text is not sanitized.** Umbraco's default is `NoopHtmlSanitizer`, and
  `model.html('alias')` renders what an editor stored. A careless or compromised
  editor account is therefore a stored-XSS vector for visitors. Closing this
  properly means choosing a sanitizer, which is a dependency decision rather than
  a default we should pick for a site — link URLs are already scheme-checked, so
  `javascript:` from the link picker does not survive.
- **SVG and HTML may be uploaded** to the media library, as Umbraco's own
  disallow-list allows. The `sandbox` header above is what makes that safe to
  serve; a site wanting them refused outright should narrow the upload settings.

## Running a cluster

A deployed site is run as well as served: backed up, given content, upgraded.
The commands that do it are the `bunbraco` binary's, and the same functions are
exported from `@bunbraco/cli` — `backup`, `contentCheck`, `contentImport`,
`contentExport`, `upgradePlan`, `upgradeCheck`, `upgradeFix`, `upgradeRun`,
`pauseEditing`, `resumeEditing`, `editingPaused` — taking a resolved config and
returning results as data, for tooling that drives an environment without a
terminal. The `bunbraco` umbrella exports `createServer`, for a host process
that needs the server handle rather than only what `Bun.serve` takes.

### Health while the database moves

`/health` is what a load balancer drains on, so what makes it fail is chosen
carefully:

| Node | Behind the database (an upgrade or a schema deploy cut over) | A contract has run past it | Editing paused |
| --- | --- | --- | --- |
| `web` | **200**, `readOnly: true` — its reads are still correct as-of its own state | 503 | 200 |
| `api`, `all` | 503 — editors must land on a node that can save | 503 | 200 |

The `web` row is what keeps an upgrade invisible to readers. A new node cannot
boot until the upgrade has run, and every old node falls behind the moment it
does; if old renderers drained then, there would be a window with nothing
healthy to serve. An expand-only change — every minor and patch, since a
contract may only ship in a major (`10-packaging-and-upgrades.md`) — leaves an
old node's reads correct, so it keeps serving until it is replaced. A
contract (a framework contract, or `schema purge`) is ledgered as one, and a
`web` node that is behind drains as soon as it sees one ran after it booted.

### Pausing editing

```
bunbraco maintenance pause --reason "restoring Monday's backup"
bunbraco maintenance status
bunbraco maintenance resume
```

A flag in `key_value`, read by the write gate inside every editor's write
transaction, so it takes effect on every node at once rather than at the next
poll. A refused save is a 409 like any other, naming the reason. Readers are
unaffected and no node drains; `/health` reports `paused` so the backoffice can
say why saves fail. Content imports are not editor writes and are not refused —
which is what lets a restore proceed while editors wait.

### Reading the cluster back

Every node records itself in `server` — its id, schema state and role — at boot
and on each poll. `liveNodes(db, { seenWithinMs })`, exported from the
umbrella, returns the nodes that have polled within a window: which are
answering the public site, which the editor, and on which schema state.

## Documents

|                                                                     |                                                                                                                                         |
| ------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| [`00-overview.md`](docs/00-overview.md)                             | mission, decisions, non-goals, Umbraco→bunbraco glossary                                                                                |
| [`01-architecture.md`](docs/01-architecture.md)                     | module boundaries, server composition, cross-cutting infrastructure                                                                     |
| [`02-data-model.md`](docs/02-data-model.md)                         | schema, naming map, the versioning model, dialect strategy, migrations                                                                  |
| [`03-api-contract.md`](docs/03-api-contract.md)                     | routing, response conventions, the document payload, build order                                                                        |
| [`04-backoffice-hosting.md`](docs/04-backoffice-hosting.md)         | serving the SPA, import map, the auth contract, boot sequence                                                                           |
| [`05-rendering.md`](docs/05-rendering.md)                           | TSX templates, the published-content model, URL routing                                                                                 |
| [`06-features.md`](docs/06-features.md)                             | must-have / could-have / out-of-scope inventory                                                                                         |
| [`07-roadmap.md`](docs/07-roadmap.md)                               | phases with exit criteria, and the risk register                                                                                        |
| [`08-testing.md`](docs/08-testing.md)                               | test strategy and what Phase 0 covers                                                                                                   |
| [`09-schema-as-code.md`](docs/09-schema-as-code.md)                 | document types, data types and languages as TOML files; sync; the backoffice writes them                                                |
| [`10-packaging-and-upgrades.md`](docs/10-packaging-and-upgrades.md) | how a site consumes the framework; migration ledger, `--plan`, expand/contract; the pre-upgrade check and `--fix` that gate the upgrade |
| [`11-assistant.md`](docs/11-assistant.md)                           | the optional AI helper: why the boundary is real, query and propose, approval and staleness, TSX guardrails, MCP, providers                |
| [`12-schema-at-runtime.md`](docs/12-schema-at-runtime.md)           | the shared schema store, importing files at runtime, how the version moves with the change, and getting it back into git                   |
| [`13-content-transfer.md`](docs/13-content-transfer.md)             | moving content between environments: the bundle format, what travels and what never does, dependency classification, naming a node         |
