# Backoffice hosting

How the real Umbraco 18 backoffice SPA is served from Bun. All facts here were
verified against `/Users/adam/dev/Umbraco-CMS` @ `release-18.2.0` and against the
published npm tarball.

## Where the client comes from

The backoffice is consumed from npm, pinned to `@umbraco-cms/backoffice@18.2.0`,
and completed into a browser-runnable tree by a Bun script. **No Node, no npm
scripts, no .NET/NuGet anywhere in this project.**

### Why npm alone is not enough

The npm package is the `build:for:npm` output — `tsc --declaration` only. The CMS
ships `build:for:cms`, which additionally runs 42 per-package Vite builds,
`generate:manifest`, and `copy-to-cms.js`. Inspecting the tarball
(23 MB unpacked, 15,396 files) against what the HTML shell references:

| Needed | In the npm tarball? |
| --- | --- |
| `apps/app/app.element.js`, `packages/**`, `libs/**` | yes |
| `assets/lang/*.js` (28 locales) | yes |
| `external/*` | present, **but only as re-export stubs** |
| `css/umb-css.css`, `light.css`, `dark.css` | **no** |
| `umbraco-package.json` (the importmap manifest) | **no** |
| `assets/favicon.svg`, logos | **no** |

The `external/*` problem, concretely — npm's `dist-cms/external/lit/index.js` is:

```js
export * from 'lit';
export * from 'lit/decorators.js';
…
```

Bare specifiers nothing resolves: `lit` is a `peerDependency` supplied "for types
only", and Umbraco resolves it at runtime from the *Vite-bundled* external.

Helpfully, `apps/app/app.element.js` imports **relatively**
(`../../external/lit/index.js`, `../../packages/core/auth/index.js`), so the
import map is needed only for bare `@umbraco-cms/backoffice/*` specifiers used by
dynamic imports and plugins — not for the app's own module graph.

### `bun run vendor:backoffice`

Closes every gap with Bun alone, writing `packages/backoffice-dist/dist/` (committed, with a
`VERSION` file recording the upstream version):

| Step | Produces |
| --- | --- |
| 1. copy `node_modules/@umbraco-cms/backoffice/dist-cms/{apps,packages,libs,assets}` | the app itself |
| 2. `bun build dist-cms/external/<m>/index.js --target=browser --format=esm` for each of the 10 externals | self-contained `external/*` bundles |
| 3. copy `node_modules/@umbraco-ui/uui/dist/themes/{light,dark,high-contrast}.css` | 3 of the 4 stylesheets |
| 4. copy 3 files from `packages/backoffice-dist/upstream-static/` — `css/{umb-css,rte-content,umbraco-blockgridlayout}.css`. Umbraco's three SVG marks are deliberately not seeded; `BRANDED_ASSETS` serves bunbraco's at those paths | the rest |
| 5. bundle every remaining bare specifier the tree imports (27 of them: all `@tiptap/*`, `diff`, `uuid`) into `deps/<specifier>/`, each from a generated shim entry | third-party code the client imports directly rather than through `external/*` |
| 6. generate `umbraco-package.json` from the package's `exports`, extended with the `deps/` entries | the import map |
| 7. `bun build` the client's own modules — every import-map target under `apps/`, `packages/`, `libs/`, plus the shell's `app.element.js` — with `splitting` on | 132 entry points and ~1,870 shared chunks, in place of one file per source module |

`packages/backoffice-dist/dist/` is **not** committed — it is 69 MB and reproducible in under
a second. What *is* committed is `packages/backoffice-dist/upstream-static/`: the 6 files (60 KB)
that exist only in the Umbraco source tree, so a fresh clone needs nothing but
`bun install`. `bun run vendor:refresh-static` re-seeds them from `$UMBRACO_SRC`
and is only needed when bumping the pinned backoffice version.

The generated import map is **self-verifying**: an entry is emitted only if its
target file was actually produced, and anything dropped is reported. An import map
that advertises a module the server does not serve fails at runtime with an opaque
module-resolution error, which is much harder to diagnose than a missing feature.

Step 2 is verified: `bun build` inlines the real dependency and leaves no bare
imports (lit → 91 KB, rxjs → 79 KB, uui → 680 KB).

Step 5 reimplements `devops/importmap/index.js` exactly — for each `exports`
entry ending in `.js`, map `@umbraco-cms/backoffice/<key>` to the path with
`./dist-cms` replaced by `/umbraco/backoffice`. Upstream's generated manifest is
just `{ name, version, extensions: [], importmap }`, so there is nothing else to
reproduce.

### Step 7, and why the client is bundled

npm ships `tsc` output: one file per source module, 7,557 of them. Served verbatim,
a single sign-in fetched **4,583 distinct modules**, and because the login flow is
three full-page navigations — `/bunbraco` links the whole graph to discover there
is no session, then `/authorize`, then `/oauth_complete` — each one re-linked the
graph, for **12,964 requests**. Only the first pass touches the network; the rest
are browser cache hits, but every one still costs a request through Chrome's
network stack and a V8 compile. That is the dominant cost of a sign-in, in the
browser suite and for a real editor alike. Bundling takes it to **813 requests**.

Two things constrain the bundle's shape:

- **The import map is a public surface.** An extension imports
  `@umbraco-cms/backoffice/<x>`, so there must still be a file at each mapped
  path. Every mapped target is therefore an entry point, and `splitting` puts
  their shared code in common chunks — which is also what makes a specifier
  resolve to the *same instance* the rest of the client uses.
- **`external/*` and `deps/*` must stay out of it.** Per the note above, the
  client reaches lit **relatively** (`../../external/lit/index.js`) 814 times, so
  a bundler follows those happily and inlines a copy — while the import map goes
  on advertising the standalone bundle. An extension importing
  `@umbraco-cms/backoffice/external/lit` would then get a second
  `ReactiveElement` with its own element registry, which shows up as components
  that quietly fail to render. The build therefore resolves any relative path that
  lands in `external/` or `deps/` back to the bare specifier and marks it
  external; 909 imports are rewritten that way, and `tests/vendor.test.ts` asserts
  no new copy of lit appears.

The unbundled tree still links, so a failed bundle is reported and exits non-zero
rather than silently shipping one file per module. The raw modules stay on disk
but are unreachable from any entry point, which is why `check:modules` walks 1,914
modules rather than the 6,560 it crawled before.

Two further passes were needed once the module graph was actually crawled:

- **Non-runtime pruning.** npm ships `vite.config.js`, `openapi-ts.config.js`,
  `*.test.js` and friends. They are never loaded by a browser, and their
  build-tool imports (`vite`, `@open-wc/testing`) look exactly like missing
  runtime dependencies. 103 files are pruned from the served tree.
- **`package.json`.** `packages/sysinfo/repository/sysinfo.repository.js` imports
  `../../../../package.json` for the version it reports, so it is copied in.

**Bundle each dependency from a shim entry, not its resolved file.** The shim is
one line — `export * from '<specifier>'`, plus `export { default } from …` when the
target has one — and it matters for two reasons:

- Bun **tree-shakes a pure re-export barrel** used as an entry point down to
  nothing, emitting an export clause whose bindings do not exist:

  ```js
  // the whole of deps/uuid/index.js, 152 bytes, before the fix
  export{h as version,b as validate,N as v7,A as v6,T as v4,…};
  ```

  A browser refuses to link that — `Uncaught SyntaxError: Export 'A' is not
  defined in module` — and it takes the whole backoffice down, because the failure
  is at link time, not on first use. Bundling the shim instead yields the real
  10 KB module. Minification is not the cause; the barrel shrinks to nothing with
  `minify: false` too.
- Resolving the path ourselves **pins the Node build** of a package that ships
  separate browser and node entries (`uuid` resolves to `dist-node/index.js`).
  Handing Bun the bare specifier applies browser export conditions instead.

**JSON imports are inlined.** `packages/sysinfo` does
`import packageJson from '../../../../package.json'` for the version it reports.
A browser rejects a JSON module without an import attribute, and the relative path
is written for npm's layout, which has a `dist-cms` level we flatten away — so it
escapes the served root too. Umbraco never hits either problem because its Vite
build inlines the value; vendoring does the same, and `package.json` is then not
served at all.

**Vite import suffixes.** `external/monaco-editor` uses two Vite-only forms —
`monaco-editor/…/x.worker?worker` and `editor.main.css?inline`. A Bun bundler
plugin translates both: each worker is built separately into
`deps/monaco-workers/`, and `?worker` becomes a `Worker` subclass pointing at it;
`?inline` becomes the file's contents as a default-exported string. monaco's
`exports` map in 0.57 rewrites the deep worker paths, so they are resolved from
the package directory instead.

`$UMBRACO_SRC` defaults to `../Umbraco-CMS` and is read only by
`vendor:refresh-static` — never during an ordinary build, test or run.

**Measured result:** 168 import-map entries, 10 of 10 externals bundled, 27 bare
dependencies bundled, 103 non-runtime files pruned, 90 MB output.

## Verifying the result

Two checks, because they catch different things.

**Resolution** — `tests/boot.test.ts` crawls every module reachable from
`apps/app/app.element.js` through the served import map and asserts nothing 404s
and nothing is left unresolvable: **6,556 modules, 0 broken**.

**Linking** — `bun run check:modules` (also a test) does what resolution cannot.
A browser additionally checks that every named import is really exported and that
each module is valid ESM, and reports failure as *"Export 'X' is not defined in
module"*. The check walks the same graph, follows `export * from` chains, and
verifies every binding: **6,555 modules, 0 missing exports, 0 that will not link**.

Both bugs above got past the resolution crawl and were caught only by the link
check — `deps/uuid/index.js` resolved and served a 200 with the wrong contents.
Sources go through Bun's transpiler before analysis, because the npm package's
JSDoc contains example `import` statements that a regex would otherwise believe.

Neither is a substitute for opening a browser: together they prove every module
resolves, is served correctly and will link, not that the app throws no runtime
errors.

### The login SPA

`src/Umbraco.Web.UI.Login` is a private package, never published to npm, and its
`tsc` step reaches into `Umbraco.Web.UI.Client/src` via path aliases. Since we are
avoiding the Node toolchain, we ship **our own login page**
(`backoffice-host/assets/login.js`, built from the published UI library) against
the same endpoints. Besides signing in it serves the two links a user may be
sent, as Umbraco's does: `…/login?flow=invite-user&userId=…&inviteCode=…`
verifies the invitation and sets the first password
(`user/invite/verify`, `user/invite/create-password`), and
`?flow=reset-password&userId=…&resetCode=…` sets a new one
(`security/forgot-password/verify`, `…/reset`); with `allowPasswordReset` on,
"Forgotten password?" asks for a link (`security/forgot-password`).

## Static serving

| Route | Serves |
| --- | --- |
| `/umbraco/backoffice/<hash>/*` | `packages/backoffice-dist/dist/*` — the `<hash>` segment is stripped |
| `/umbraco/backoffice/*` | `packages/backoffice-dist/dist/*` |
| `/umbraco/login/*` | `vendor/login/*` |
| `/packages/<name>/*` | the installed npm extension's own directory, resolved from the site's `node_modules` ([`17-bundles.md`](17-bundles.md)) |

`<hash>` is a cache-buster Umbraco derives from the version
(`UmbracoBackOfficePathGenerator.BackOfficeCacheBustHash`, SHA1 of version +
minifier config) and rewrites away in middleware. We do the same: compute it from
the vendored `VERSION` file, serve the hashed prefix with
`Cache-Control: public, max-age=31536000, immutable`, and serve the unhashed
prefix with `no-cache`. ETag/304 on all of it.

## The HTML shell

`GET /umbraco` — and **every** sub-path (`/umbraco/section/...`, `/install`,
`/upgrade`, `/oauth_complete`, `/logout`, `/preview`, `/error`) — returns:

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <base href="/umbraco/" />
  <link rel="icon" type="image/svg+xml" href="/umbraco/backoffice/<hash>/assets/favicon.svg" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta name="robots" content="noindex, nofollow" />
  <title>Bunbraco</title>
  <link rel="stylesheet" href="/umbraco/backoffice/<hash>/css/umb-css.css" />
  <link rel="stylesheet" href="/umbraco/backoffice/<hash>/css/light.css" />
  <script type="importmap">{ "imports": { … } }</script>
  <script type="module" src="/umbraco/backoffice/<hash>/apps/app/app.element.js"></script>
</head>
<body class="uui-font uui-text" style="margin:0;padding:0;overflow:hidden">
  <umb-app lang="en-US" keep-user-logged-in></umb-app>
</body>
</html>
```

`<base href>` with a trailing slash is mandatory — the client router derives its
base path from it (`packages/core/router/router-slot/util/url.ts`).
`<umb-app>` also accepts `server-url`, `backoffice-path` and `bypass-auth`.

The login shell at `/umbraco/login` is the same minus `umb-css.css`, loading
`/umbraco/login/login.js` and rendering:

```html
<umb-auth lang return-url logo-image logo-image-alternative background-image
          username-is-email allow-user-invite allow-password-reset
          disable-local-login></umb-auth>
```

## Import map

Merged from every discovered `umbraco-package.json`:

1. `packages/backoffice-dist/dist/umbraco-package.json` — the core manifest, ~143 entries
   generated from the client's `package.json` `exports`
   (`@umbraco-cms/backoffice/auth` → `/umbraco/backoffice/packages/core/auth/index.js`)
2. each installed npm extension's `bunbraco` field, from the site's own
   dependencies ([`17-bundles.md`](17-bundles.md)); asset paths are rewritten
   to `/packages/<name>/…`

Then `/umbraco/backoffice` is textually replaced with
`/umbraco/backoffice/<hash>`, mirroring `HtmlHelperBackOfficeExtensions`.

A package manifest is `{ name, id?, version?, allowPublicAccess?, allowTelemetry?,
allowCacheBusting?, extensions: unknown[], importmap?: { imports, scopes? } }`.

### What moves with `backOfficePath`, and what does not

The editor is mounted at `/bunbraco` (`BUNBRACO_BACKOFFICE_PATH`, defaulting to
`DEFAULT_BACKOFFICE_PATH` in `@bunbraco/core`, the single place the default is
written). Moving it does **not** move the API, exactly as in Umbraco, where
`UmbracoPath` does not affect `VersionedApiBackOfficeRoute`.

| Moves with `backOfficePath` | Fixed, because the vendored client hard-codes it |
| --- | --- |
| the SPA shell and its routes (`/bunbraco/section/…`) | `/umbraco/management/api/v1/**` — the contract, and the generated SDK |
| the login page and its assets | `/umbraco/serverEventHub` — `server-event.context.js` |
| static assets, `/bunbraco/backoffice/<hash>/…` | `/umbraco/PreviewHub` — `preview.context.js` |
| our own plugin, `/bunbraco/bunbraco/…` | the security endpoints, which are Management API operations |
| `oauth_complete` and `logout`, the SPA's own routes | the back-office graphics, served under the API path |

The constants for the fixed paths live in `packages/core/src/api-paths.ts`, so
nothing derives an API path from `backOfficePath` by accident. The vendored
manifest's asset paths are rewritten from the literal the vendor script bakes in
(`VENDORED_ASSETS_PATH`) onto the configured `assetsPath` — keying that rewrite
off `virtualDirectory` silently breaks the import map the moment the editor
moves.

### Replacing a core extension

`packages/backoffice-host/plugin/umbraco-package.json` is our own manifest. Its
entries name their modules under the `/bunbraco-plugin/*` placeholder, which
`collectManifests` rewrites to `pluginPath` — `/bunbraco/bunbraco/*` by default —
so the manifest on disk need not know where the editor is mounted. To put
something of ours where one of Umbraco's
extensions was, the manifest entry names it in `overwrites`: the Welcome
dashboard declares `overwrites: ['Umb.Dashboard.UmbracoNews']` and so takes the
place of Umbraco's news dashboard in the Content section.

Prefer that to the registry's `exclude()` or `unregister()`. `overwrites` is
resolved by the extension initializer as it reads the manifests, whereas the
registry calls mutate it after the fact — and changing the registry once the
backoffice is rendering makes every open section re-evaluate its extensions,
which is the failure the TSX entry point documents at the top of `tsx-editors.js`.

### The view editor's TSX dialect

Umbraco's template and partial view editors are `umb-code-editor` with
`language="razor"` written into the element's own template, and monaco has no
`tsx` language to swap it for. So `tsx-editors.js` configures the dialect rather
than registering one, in three parts:

- **The mode stays monaco's `typescript`.** TypeScript's worker attaches only to
  the `typescript` and `javascript` modes, and that worker is where every
  completion, hover and error comes from. A `tsx` language of its own would
  tokenise correctly and then be ignored by it.
- **The model is named for what it is.** TypeScript decides whether a file may
  contain JSX from its *file name*, and the model monaco creates for itself is
  `inmemory://model/1` — under which every tag in a view is a syntax error. The
  model is replaced by one at `file:///Views/view-<n>.tsx`, mirroring `Views/` on
  disk so that a view's `../schema/content-types.d.ts` resolves in the editor the
  way it resolves for `tsc`.
- **The types are served, not guessed.** `GET
  <backoffice>/bunbraco/api/editor-types` (signed in) returns
  `@bunbraco/render`'s own sources — the package ships them, and they are what
  `bunbraco` re-exports to a view, so they cannot drift from it — plus the
  schema's generated `content-types.d.ts`, read fresh on every request. monaco
  holds them as extra libs under `file:///node_modules/bunbraco/`, which is where
  TypeScript's own directory-index lookup arrives from a bare
  `import … from 'bunbraco'`: no import map, and no `paths` entry, because the
  editor has neither a base URL nor a working directory to resolve one against.

The compiler options are `apps/site/tsconfig.json`'s — `jsx: react-jsx`,
`jsxImportSource: 'bunbraco'`, `strict`, `allowImportingTsExtensions`,
`moduleResolution: bundler` — so that what the editor underlines is what `tsc`
would report. `bundler` is passed as its number, `100`: monaco's editor-side
`ModuleResolutionKind` names only Classic and NodeJs, because the enum predates
the option, but the worker's own TypeScript knows it and monaco passes compiler
options through untouched. `tests/editor-types.test.ts` lays the served
declarations out as the editor does and type-checks a view in them with the
repo's own compiler, so the layout and the options are held to something
stronger than a source-level guard.

monaco is imported when the first view opens rather than at boot: it is several
megabytes and most sessions never open one. If that import or the types request
fails, the editor still opens on Umbraco's own terms, without the dialect.

A dashboard element must extend **`UmbLitElement`**, not Lit's `LitElement`.
Umbraco uses a dashboard as a controller host; a plain element renders nothing
and the console reports `controllerHost.provideContext is not a function`.

## Boot sequence the server must satisfy

From `apps/app/app.element.ts` `#setup()`:

1. **`GET /umbraco/management/api/v1/server/status`** → `{ serverStatus: "Run" }`
   (`Unknown|Boot|Install|Upgrade|Upgrading|Run|BootFailed`)
2. **`GET /umbraco/management/api/v1/server/configuration`** →
   `{ allowPasswordReset, versionCheckPeriod, allowLocalLogin, umbracoCssPath, signalR: { skipNegotiation } }`

   *If either of these fails the app hard-redirects to its error page.* They are
   the two boot-critical endpoints.
3. `GET …/manifest/manifest/public` (anonymous) — login-screen extensions
4. `POST …/security/back-office/token` with the `refresh_token` grant, to restore
   a session (a 4xx here simply means "not signed in")
5. Route on runtime level: `Install` → `/install`, `Upgrade` → `/upgrade`,
   `Upgrading`/`BootFailed` → error, `Run` → the backoffice
6. `GET …/manifest/manifest/private` (authenticated)
7. `GET …/user/current` → `allowedSections[]`, `permissions[]`,
   `fallbackPermissions[]`, `languageIsoCode`, start-node ids + root-access flags,
   `hasAccessToAllLanguages`, `hasAccessToSensitiveData`, `isAdmin`,
   `avatarUrls[]`, `userGroupIds[]`
8. SignalR `/umbraco/serverEventHub` on authorization
9. Lazily `GET …/server/information` → `{ version, assemblyVersion, baseUtcOffset, runtimeMode }`

Sections the client expects to see in `allowedSections`: `Umb.Section.Content`,
`Umb.Section.Media`, `Umb.Section.Settings`, `Umb.Section.Users`,
`Umb.Section.Members`, `Umb.Section.Translation`, `Umb.Section.Library`.

## Auth contract

Single OpenAPI security scheme, `Backoffice-User`, OAuth2 authorization-code:

```
GET  /umbraco/management/api/v1/security/back-office/authorize
POST /umbraco/management/api/v1/security/back-office/token
POST /umbraco/management/api/v1/security/back-office/revoke
GET  /umbraco/management/api/v1/security/back-office/signout
POST /umbraco/management/api/v1/security/back-office/login
POST /umbraco/management/api/v1/security/back-office/verify-2fa
POST /umbraco/management/api/v1/security/forgot-password{,/verify,/reset}
GET  /umbraco/management/api/v1/security/back-office/link-login-key?provider=
POST /umbraco/management/api/v1/security/back-office/{link-login,unlink-login}
GET  /umbraco/management/api/v1/security/back-office/ExternalLinkLoginCallback
GET  /umbraco/management/api/v1/security/back-office/graphics/{logo,login-logo,login-logo-alternative,background}
```

Non-obvious requirements, all of which the client depends on:

- `client_id=umbraco-back-office`, `scope=offline_access`, `response_type=code`,
  `code_challenge_method=S256`, `prompt=consent`, optional
  `identity_provider=<name>` (omitted when the provider is `Umbraco`) and
  `login_hint`
- `redirect_uri = {origin}/umbraco/oauth_complete`;
  post-logout redirect `{origin}/umbraco/logout`
- PKCE verifier is 128 chars of `[A-Za-z0-9]`; challenge is URL-safe base64 SHA-256
- **Reference tokens, not JWTs.** The token response must include `expires_in`;
  the token *values* are redacted. Real values live in data-protected httpOnly
  `Secure` cookies named `__Host-umbAccessToken<SiteName>`,
  `__Host-umbRefreshToken<SiteName>`, `__Host-umbPkceCode<SiteName>`
  (see `Umbraco.Cms.Api.Common/DependencyInjection/HideBackOfficeTokensHandler.cs`)
- The client sends `Authorization: Bearer [redacted]` and
  `refresh_token=[redacted]` with `credentials: include`; the server substitutes
  the real value from the cookie
- A `400`/`401` token response **with** a JSON `{"error": …}` body is treated as
  definitive (no retry); any other failure is treated as transient
- The client must never be made to call `validateToken()` per request — that
  revokes the previous reference token
- API users authenticate with `grant_type=client_credentials`, their own
  `client_id` and secret, and receive a real bearer token with no refresh token
  — a machine client, not the SPA. Umbraco requires the prefix
  `umbraco-back-office-` here; bunbraco requires `bunbraco-back-office-`, since
  this one is a name an administrator types rather than anything the client
  sends. Migration 020 renamed existing credentials in place, keeping their
  secrets. The `client_id` above is a different thing and stays as it is: the
  vendored client hard-codes it, so the server can only recognise it
- The contract marks `security/forgot-password`, `…/reset` and
  `security/configuration` secured, but Umbraco's `DenyLocalLoginIfConfigured`
  policy lets anyone through while local login is allowed, since the login page
  calls them before sign-in; the router does the same

## Authorization

Every Management API call is authorized before its handler runs, by one table
(`api-management/src/authorization.ts`) taken from Umbraco's controller
policies:

- **Sections.** Each area demands sections, any one of a set and every set:
  documents need Content; document types are readable from Content, Library or
  Settings but changed only from Settings; data types likewise; templates are
  readable from Settings or Content; media needs Media; the dictionary,
  Translation (its tree Translation or Settings); users and groups, Users;
  upgrades, the admin group. Trees that pickers open (documents, media) accept
  any section. The current user, user data, items, cultures and language reads
  need only a signed-in user.
- **Documents.** Each operation's verb on the node it names — Read to open,
  Create on the parent, Update, Publish (on the whole branch for publish with
  descendants), Unpublish, Delete and trash, Move plus Create on the target,
  Duplicate plus Create on the target, Sort on the parent and every child,
  Rollback, CultureAndHostnames, PublicAccess, CreateBlueprint; the recycle
  bin's operations at the bin — and the node must lie at or below one of the
  caller's start nodes (the root and the bin need root access). Publishing
  checks the cultures too, against the group's languages. A missing node is not
  refused, so the handler answers 404 as Umbraco does.
- **Media** checks start-node path access only; media has no verbs.

A refusal is a bare `403`, as ASP.NET's authorization answers. Trees are not
refused but filtered: a restricted user's root shows only the way to their
start nodes, those nodes' ancestors marked `noAccess`. Users and user groups
carry rules about people — only admins see or touch admins, a non-admin hands
out only groups they are in and start nodes they reach, a non-admin sees and
edits only their own groups — which the users port enforces, answering with
Umbraco's statuses (`401` for the editor rules, `403` for the resource ones).

## Real-time channels

- `/umbraco/serverEventHub` — SignalR hub emitting `notify` with
  `{ eventSource, eventType, key }`; drives live tree/store invalidation.
  It is not optional: while connected, the client serves entity details from a
  cache that only these events clear, so a save that announces nothing leaves
  the editor redrawing the old copy. The router announces every successful
  `Post`/`Put`/`Delete` on an entity (`serverEventFor` in `@bunbraco/api-management`):
  `Created` with the generated key, `Deleted`, `Trashed` for a move to the
  recycle bin, otherwise `Updated`. Validation and folder operations announce
  nothing. As in Umbraco, the event reaches every connected user, including the
  one who made the change, before the response is sent.
- `/umbraco/PreviewHub` — emits `refreshed` with a document's key when it is
  saved, so an open preview reloads; signed-in only, like the event hub. Both
  share one Bun WebSocket handler, routed by the hub each socket joined
  (`combineHubs`).

Both honour `server/configuration.signalR.skipNegotiation`. Setting it `true`
lets us serve a **raw WebSocket** speaking the SignalR JSON hub protocol and skip
implementing the `/negotiate` handshake — that is the intended shortcut.

## Cross-cutting HTTP contract

- RFC 7807 `ProblemDetails` for every error (`isProblemDetailsLike` validates it)
- `401` triggers the client's re-auth queue, which then replays GETs
- Optional `umb-notifications` response header: a JSON array of
  `{ type, headline, message }`, surfaced as toasts and stripped by the interceptor
- Same-origin, or CORS with `Access-Control-Allow-Credentials: true`

## Localisation

UI strings are **client-side** — `localization` extension manifests pointing at
`assets/lang/*.js` (28 locales), served from the vendored client. The server
contributes only the `lang` attribute on `<umb-app>`,
`user/current.languageIsoCode` (which a user changes with
`PutUserCurrentProfile`), `GET …/culture`, and any extra `localization`
manifests from packages. `…/dictionary` is *content* dictionary items (WP-6.6)
and unrelated.

## Free executable spec

`Umbraco.Web.UI.Client/mocks/` is an MSW mock server covering ~45 endpoint groups,
with `mocks/db` and `mocks/data` fixtures. It is the best available reference for
exact response shapes and a ready source of seed data — consult it whenever the
OpenAPI schema is ambiguous.

## Bare dependencies are bundled together

Packages that import a third-party dependency by bare specifier (the npm
build leaves those; Umbraco's Vite build inlines them) are bundled by
`scripts/vendor-backoffice.ts` into `deps/`, **in one build with code
splitting**: an entry per specifier, shared modules once under
`deps/chunks/`. Built one at a time, each Tiptap extension inlined its own
`@tiptap/core` and ProseMirror, and ProseMirror refuses to mix copies — the
rich text editor crashed on load. `tests/vendor.test.ts` checks there is one
copy.

