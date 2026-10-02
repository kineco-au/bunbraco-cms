# Testing

## Commands

| Command | Does |
| --- | --- |
| `bun run check` | the gate: Biome (formatting, lint, import order) + `tsc --noEmit` |
| `bun run fix` | fix everything Biome can: formatting, lint, import order |
| `bun run format` / `format:check` | formatting only, rewrite or verify |
| `bun run lint` / `lint:fix` | lint only, verify or fix |
| `bun run typecheck` | `tsc --noEmit` across the workspace |
| `bun run check:modules` | verify the vendored backoffice links in a browser |
| `bun test` | the whole suite against SQLite |
| `bun run test:sqlite` / `test:postgres` | pin the dialect explicitly; `test:postgres` starts the `db` container first |
| `bun run test:all` | both dialects in sequence — the real gate |
| `bun run docker:test` / `docker:test:sqlite` / `docker:test:postgres` / `docker:test:all` | the same four, inside a container over the mounted source |
| `bun run test:integration` / `docker:test:integration` | the CLI suites: creating a site, content transfer, a split deployment and the upgrade, spawned per step |
| `bun run docker:test:browser` | the browser suite in its own Playwright image, against Chromium |
| `bun run coverage:api` | implemented vs. total OpenAPI operations |
| `bun run conformance` | replay recorded request sequences, validate against schemas |
| `bun run vendor:backoffice` | rebuild `packages/backoffice-dist/dist/` from npm (not committed) |
| `bun run vendor:refresh-static` | re-seed `packages/backoffice-dist/upstream-static/` from `$UMBRACO_SRC` |

`check` and `fix` are deliberately symmetric: both run Biome's own `check`, which
covers formatting, lint *and* assist actions such as import ordering. Using
`format` + `lint` as the gate would let `fix` change things the gate never
verified — import order was exactly that gap, and 31 files drifted before the
commands were paired up.

`BUNBRACO_DB=sqlite|postgres` selects the dialect, and
`BUNBRACO_POSTGRES_URL` points at the server (see `.env.example`). Individual
Postgres tests skip with a clear message when no server is reachable, so a fresh
clone is never blocked — but note that a skip is not a pass, and `test:all` is the
real gate.

Postgres comes from the compose stack rather than a local install. `test:postgres`
brings the `db` service up, waits for its health check, and runs the suite on the
host against `localhost:5433`.

Every host command has a `:docker` twin that runs the same suite inside a container
over the same mounted source, so the two paths test the same thing: the environment
comes from one anchor in `compose.yaml`, matching what the host scripts export.
`cms-test-sqlite` declares no database and so starts no Postgres; `cms-test` brings
the `db` service up itself. Both sit behind the `test` compose profile, so
`docker compose up` never starts them, and both take a command override —
`docker compose run --rm cms-test-sqlite bun test tests/redirects.test.ts` runs one
file. The container is roughly 50% slower on macOS, because the source is a bind
mount, so the host commands are the ones to work with.

`test:ci` is the one command with no twin, on purpose: it exists so CI can supply the
dialect through job environment, and in a container the dialect is the service you
pick, so `docker:test:sqlite` and `docker:test:postgres` together are that matrix.

The browser suite has its own image, `docker/Dockerfile.browser`: Playwright's
official image with Bun copied in. That base rather than `oven/bun` plus browser
packages, because it pins the whole set of browser system libraries to the Playwright
version — the part that fails obscurely when assembled by hand. Its tag must track
the installed `@playwright/test`, or Playwright rejects the browsers it finds, and
`tests/docker.test.ts` fails if the two drift. It has its own `node_modules` volume
because that image is Debian while the CMS image is Alpine.

**One behaviour differs in the container.** The host run drives installed Google
Chrome (`channel: 'chrome'`, which is what a visitor uses); the container cannot,
because Google publishes no Linux arm64 build — `playwright install chrome` answers
"not supported on Linux Arm64". `BUNBRACO_BROWSER_CHANNEL` selects the channel and
the container sets it empty, which gives Playwright's bundled Chromium. Everything
else about the two runs is the same.

Postgres needs Docker either way; the SQLite half does not, and a host and a
container Postgres run must not overlap, since they share `bunbraco_test`.

Postgres isolation resets the `public` schema per test rather than creating a
schema per test: `SET search_path` is per-connection and Bun's SQL client pools
connections, so a search_path set by one query does not apply to the next. The
consequence is that Postgres test files must not run concurrently against the
same database — and that anything else connected to it while the suite runs will
have its tables dropped mid-query. That is why the stack provisions two
databases: `bunbraco` for the CMS and `bunbraco_test` for the suite, so a running
CMS container cannot collide with a test run.

## Layers

**Unit** — pure domain logic in `packages/core`: variance resolution, the publish
state machine, permission evaluation, URL segment generation, fallback strategies.
No database.

**Repository** — every `packages/data` repository against a real database, run
twice, once per dialect. Each test gets a fresh migrated database. This layer is
where dialect differences surface, which is why it runs against both from day one
rather than at the end.

**API contract** — each handler exercised through the router, with its response
validated against the schema from `packages/contracts/OpenApi.json`. A response that does
not match its declared schema fails the test, which is the main defence against
R1.

**Conformance** — recorded request sequences that mirror what the real backoffice
does (boot, login, open a tree, edit and publish a document). These catch ordering
and statefulness bugs that per-endpoint tests miss.

**Rendering** — TSX templates rendered against fixture content, asserting on
output HTML and on `value()` fallback behaviour.

**The CLI, end to end** — `tests/integration/*.integration.ts`: the real
commands, spawned per step as a pipeline would, against two SQLite databases
standing in for two environments. This is the only layer that covers argument
parsing, exit codes and the output somebody actually reads — everything else
calls the functions directly.

- `new-site.integration.ts` — `bunbraco init`, then `bunbraco start`, in a
  directory of its own: a bare site, one from each starter template. Nothing is
  written by the test, because the point is that what `init` writes is what
  boots. It asserts the holding page a site with nothing published serves, the
  pages a template's content produces, the order they sit in, and that the image
  bytes the template shipped are the ones the site serves back. `schema new` and
  `schema add-property` are covered here too, against a site with no types at
  all, through to `generate` typing the property they added — and `views
  check|list|new` and `assets list|new`, including a deliberately broken view
  and a template whose file is missing, and `status` both before a site has a
  database and once it is running.
- `domains.integration.ts` — `domains set`, `list`, `apply`, `undo` and
  `clear` against a site that is serving, including a hostname written by the
  CLI reaching its page over HTTP in a server booted from the file alone, and a
  `${VAR}` left unbound where the environment has not got it.
- `content-transfer.integration.ts` — export, check, import, runs, revert,
  `publish`/`unpublish`, and `--with-blobs` carrying the media bytes into a
  second environment's store.
- `upgrade.integration.ts` — three releases of one site laid out as a deploy
  lays them out, a directory each: `upgrade --plan`, `check`, `check --fix`, the
  cut-over, the ledger, the refusals, and the backup restored. It boots each
  release with `bunbraco start` and asserts over HTTP, because the guarantee the
  design turns on — the running release keeps serving its own values while the
  next one's data work is prepared underneath it — needs two node states and a
  request, not one process calling functions.

They are named `*.integration.ts` rather than `*.test.ts`, so `bun test` does not
collect them and a local run stays fast; `bun run test:integration` runs them
(note the `./` in the script — Bun treats a filename without `.test` or `.spec`
as a filter unless the path is explicit), and CI runs them on every push. Unlike
the browser suite they are not gated on a commit message: they take seconds, so
there is no reason to make them opt-in.

Writing the transfer suite found two things the unit tests could not: `content
check` printed a failed integrity hash and then exited 0, so a half-copied bundle
passed the gate and could be imported; and it pinned the *messages* the commands
print, which is what a person has to act on.

**Value model** — `tests/values.test.ts` pins the append-only invariants at the
data layer, against both dialects: only changed values append, cleared values
are versions, published reads are as-of the publish event, as-of-schema-state
reads hide newer conversions, and write gating refuses a node behind the
current state while a prepared state gates nothing.

**Schema core** — `tests/schema.test.ts`: strict parsing with located errors,
parse⇄write round-trips held byte-for-byte, every validator rule, directory
loading, and a hash that ignores order, whitespace and comments. Pure; no
database. Writing it caught the test masking itself: a duplicate alias in the
fixture shadowed the composing type in the validator's map, hiding the cycle it
was meant to find — the validator now takes the first occurrence.

**Schema sync** — `tests/schema-sync.test.ts`, both dialects: a fresh apply,
idempotence, older files skipping into compatibility mode, the version-bump rule
(applies in development, refuses in production), production refusing files
without keys and accepting them after write-back, retirement keeping every value
and revival returning the same key, deletion safety with `--force-retire-types`,
data types by alias, compositions and allowed children resolving across files in
any order, a dry run that rolls back, and export reproducing the synced files
byte-for-byte. Writing it found Postgres refusing a nested `BEGIN`: the sync's
transaction wraps repository saves that open their own, so the Postgres driver
now joins an enclosing transaction the way the SQLite one already did.

**Schema at boot** — `tests/schema-boot.test.ts`, through `createServer`: the
type from `schema/` exists with its template row and keys written back, a page
publishes and renders through the view; a document type saved in the backoffice
appears as a canonical file and disappears with it, and a read-only environment
answers 409 naming the file; removing a type file while content exists throws
`SchemaBootError`; a broken file names its location. Postgres only: two servers
on one database.

**Framework migrations** — `tests/migrations.test.ts`: the contract lint (an
expand from an earlier release, named), the ledger per step, the recorded plan
(DDL captured, nothing run, a data-reading step reported unplannable), the
newer-database refusal by name, schema operations on both dialects, production
refusing to boot with steps pending while a fresh database installs, and the
SQLite copy / Postgres dump-or-promise backup rule.

**Pending elements** — `tests/pending.test.ts`: the one comparison, then the
full loop at the data layer — a mandatory property created under a prepared
state is editable, not required and not rendered on the old node, required and
rendered on the new one, and the cut-over flips the old node to read-only; a
type with `since` in its file is hidden from the create menu on every node
below that version.

**Check, fix, upgrade** — `tests/upgrade.test.ts`: the two 5c exit scenarios
in full (a rename with a value migration across two databases with different
content; a required property plus three breaking values through check →
refuse → fix → resolve in the live editor → fix again → upgrade), the policy
and `--force`, `--set`, and an old server instance serving reads through a
cut-over then answering 503 and 409. The scenarios found two things worth
having found: a prepared sync must defer retirement and mandatory flips, not
just editor changes; and an old node re-saving an unchanged value must not
supersede a conversion it cannot see.

**Dashboard** — `tests/dashboard.test.ts`: the framework package in the
manifests with its modules served under the backoffice mount, the report
endpoint refusing without a session and filled by a development boot, and
production boot refusing a change that needs data work while rolling out an
additive one.

**Permissions and the 501 log** — `tests/permissions.test.ts`: the
administrator's fallback permissions are Umbraco's admin set (Create and
Publish included); migration 007 backfills a database seeded without them;
the development log records each missing operation once and counts repeats,
and is absent in production.

**Built-in media types** — `tests/built-in-media-types.test.ts`: the system
three are Umbraco's key for key (group, properties, data types, list view),
refuse deletion and renaming, and show as undeletable in the tree; the four
site types arrive from the scaffolded files with Umbraco's group keys and are
deletable; Folder allows all seven, or only the system three when the site
has none of the others; export writes no file for an unchanged system type
and one once it is changed (a valid override); a file taking a system alias
with another key is refused; an older database gains missing built-ins once.

**Member types** — `tests/member-types.test.ts`: per-property visibility and
sensitivity kept through save, update and the `[member-type]` file;
compositions keyed `memberType`, the tree, items, search, configuration,
folders and moves; kept apart from other kinds; a file syncing at boot; the
member-only keys refused elsewhere.

**Members** — `tests/members.test.ts`: create, read, change and delete with
groups; the values a member type declares; a duplicate username or e-mail refused
whatever the casing, and a member keeping its own on save; a create with nothing
to identify it, and an unknown member type; the collection filtered by type,
group, approval, lockout and text, and ordered both ways; the three lookups a
picker makes, including one limited to a member type; a sensitive property
withheld from a user outside the Sensitive data group and returned to one inside
it; both validate calls agreeing with the save.

**Public access and member sign-in** — `tests/public-access.test.ts`: an entry
created, read back with its group resolved, replaced and removed; a named member
resolving and a descendant reporting it is protected above; a rule naming both
kinds refused as ambiguous and one naming neither as empty. Then the part that
matters — **the body served at a protected URL**: the login page for an anonymous
visitor, the error page for a signed-in outsider, the page itself for a member of
the group, with the URL never changing; protection inherited by descendants; a
login page inside the branch it protects still rendering. Plus sign-in refusing
bad credentials, locking out after `maxFailedPasswordAttempts` and ending the
session it had; a password change ending every session; registration refused
until the site turns it on, then creating a member in its default groups; a form
post redirecting where a fetch gets JSON; and a `returnUrl` that leaves the site
being ignored.

Two things this suite is careful about, both learned the hard way here: the
member's cookies are kept out of the harness's jar (which carries the *editor's*
session, and would otherwise absorb the member's), and a port constructed in a
test is given the server's schema state — without it, values of properties the
node does not know about are not read at all, and an assertion about them quietly
passes for the wrong reason.

**Media storage** — `tests/media-store.test.ts`: the whole media library —
upload, place, serve, crop, redirect, delete — driven against a store backed by a
`Map`, with no file system behind it. If that works, S3 and Azure are a matter of
talking to the service rather than of fitting in. Plus the key-safety rules (what
may not climb out of the store), a variant cache keyed by the source's etag so a
replaced original invalidates its crops, temporary uploads placed by a *different*
store instance over the same backing store (two nodes behind a load balancer), the
file system store's root containment and empty-folder pruning, and the store the
environment builds for each of `filesystem`, `s3`, `azure` and a mistyped value.

**Redirects** — `tests/redirects.test.ts`: the tracker first — a rename 301ing the
old URL with the query string carried and the no-store headers Umbraco sends; a
move redirecting the branch below it; re-ordering the roots redirecting the page
that stops being `/`; two renames in a row leaving the *oldest* URL
resolving to where the page is now, which is what a document-keyed rule buys; a
reverted rename leaving the live URL alone and no rule behind it; nothing recorded
with `trackRedirects: false`; a hostname scoping a rule to one of two sites that
both have `/about`; one culture redirected while the other is untouched. Then the
configured rules — exact, subtree and regular-expression patterns, a `{ document }`
target following a rename and going quiet once the page is unpublished, a live page
beating a rule for its own URL until that page is retired, the boot sync removing a
rule dropped from config, and the API refusing to delete a configured rule (409)
while deleting a tracked one.

The one that earned its keep: every tracker test failed at first, because `commit`
reads the *new* routes from the cache and so rebuilds the snapshot a moment before
writing the rule into it. The rule existed in the database and answered nothing.
Reading and writing the same cached derivation in one operation is the shape to
watch for — the fix is that `commit` drops the cache after it writes.

**Elements** — `tests/elements.test.ts`: the Library section end to end. What the
create dialog reads (`document-type/allowed-in-library`, which offers a type only
when it is both an element type and flagged for the library); the tree mixing folders
and elements, with a folder reporting no type and a `NotCreated` variant; ancestors,
siblings, item and folder-item lookups, search; the editor round trip and its
configuration; the rule that a **draft may leave a mandatory property empty while
publishing may not** — Umbraco's, and the one documents already follow — with the
same JSON-path errors; publish, the published read against a newer draft, unpublish;
create-and-publish refusing before it creates anything; move, copy, folder move, and
the below-itself refusals; the bin through trash, list, original parent, restore and
empty; a trashed folder taking its branch unpublished with it; versions, a version
read back, rollback and prevent-cleanup; the audit log; and the reference endpoints
answering rather than 501ing.

Then the rendering half: a page picking two elements renders both in the order
picked, with their own values and type; unpublishing one drops it from the page and
publishing it again brings it back; a draft edit does not reach the page but a
publish does; trashing drops it; and a deleted pick leaves no gap in the array. Plus
`bunbraco generate` narrowing a picker to `Array<TypedElement<Quote>>` for one
allowed type and `Array<TypedElement<Quote> | TypedElement<Aside>>` for two — that
last assertion exists because `A | B[]` binds as `A | (B[])`, which the generator got
wrong first time.

That suite found the one real defect in the package, and it was in the migration
rather than the feature: adding the `-22` recycle-bin node unconditionally made
`seedContent` — which only seeds while `node` is empty — skip the entire seed, so no
data types existed and every content type failed to resolve. 40 tests across the
suite went red, none of them about elements. The fix guards the insert with
`FROM node`, and `bun run docker:test:sqlite` on a clean database is what proves it.

**The create dialog's chain** — `tests/documents.test.ts` "the create dialog under a
page reads its type's allowed children, not the root set". Three calls in order:
`item/document` gives the parent's document type, that type's `allowed-children` is
what the dialog offers, and `allowed-at-root` is deliberately a different list. If
the item response ever stopped carrying `documentType`, the client falls back to the
root set — so a page-only child type would silently vanish from the dialog while
every endpoint still answered correctly. That is the failure this pins, and it is
invisible from any one endpoint.

**Server events** — `tests/server-events.test.ts`: the live-update WebSocket's
SignalR handshake, invocations and close over a real socket; the upgrade
refused without a session and for an unsupported protocol; tree ancestors
answering `[]` for a missing id, as Umbraco does.

**Media types** — `tests/media-types.test.ts`: a save reads back in the
media-type shape and writes `schema/media-types/<alias>.toml` under
`[media-type]`; update and delete follow the file; allowed children,
compositions (keyed `mediaType`), allowed parents, composition references,
the tree, items, search, configuration, folders and moves; media and
document types kept apart but sharing one alias space; a file syncing at
boot; `templates` rejected in a media-type file.

**Settings section** — `tests/settings.test.ts`: document-type configuration,
batch, search, allowed parents, composition references and the available-
compositions rules (never itself, never a type that uses it, never a type with
compositions of its own, element types see only element types, alias clashes
flagged); folders as a tree with `foldersOnly`, siblings, ancestors, rename,
move and the non-empty refusal, with the `folder` key following in the files
and the sync creating a path a file names; copy; "create template" writing
the view and attaching it; the editor picker's filter, data-type search,
referenced-by, the data type's file (and the built-in's only once changed),
in-use refusal, folders/copy/move; the template tree by `layout`; languages
CRUD with `languages.toml` following; and every Settings tree answering.

**Users and permissions** — `tests/users.test.ts`: user CRUD with Umbraco's
validation and derived states; list and filter; update with start nodes and
the calculated result; disable (which signs the user out), enable, unlock,
delete only without login history, never yourself; passwords (your own needs
the old one, an admin's change signs the user out, reset shows a new one);
the current user's language, avatar (five crop sizes, images only),
two-factor and login providers; API users' client credentials and the
`client_credentials` grant; invitations refused without a sender, and with
one the link verified, used once, and followed by a sign-in; the forgotten-
password link; user data kept per user; groups with sections, languages,
start nodes and every permission shape round-tripped, system groups protected,
members added and removed, the admin group never emptied; sections gating
whole areas; only admins touching admins; a non-admin handing out only their
own groups; and the exit — a restricted editor's tree, reads, writes and
per-node verbs. `tests/authorization.test.ts` pins the pure rules: path
access, per-node verb calculation, start-node combination, password rules,
and the sections each operation demands.

**Variants and the dictionary** — `tests/variants.test.ts`: the WP-6.6 exit
(one culture published, then the other, rendered under two hostnames, the
empty Danish title falling back to English, the dictionary in each culture,
children routed by their culture's name, URLs per culture, publishing one
culture leaving the other's published values alone, unpublishing a culture
and then the mandatory one); mandatory languages and uncreated variants
refused; a group limited to English refused Danish; no segments offered.
`tests/dictionary.test.ts`: CRUD, the list and tree, moves never below
itself, deleting a branch, and `.udt` export and import (and the `.udt`
reader and writer escaping).

**File-system areas** — `tests/file-systems.test.ts`: for partial views,
stylesheets and scripts alike, folders and files created, read, updated,
renamed and deleted by path; names unique, of the area's extension, under a
parent that exists and never escaping the root; the tree (folders first),
ancestors, siblings and items; a non-empty folder kept. Stylesheets and scripts
are served and nothing else from their folders; every snippet saves as a
partial view and compiles.

**The log viewer** — `tests/log-viewer.test.ts`: the filter language against
Umbraco's saved searches and its undefined-never-matches rule, the text-search
fallback, CLEF written and read back rendered as Serilog renders, the files of a
range read and bad lines skipped, level counts, templates, filtering, levels,
ordering, paging, the 100 MB cap (a sparse file) and saved searches.

## The browser suite

`bun run test:browser` drives the real vendored backoffice with the installed
Chrome (Playwright, `channel: 'chrome'` by default, headless, no browser download;
`BUNBRACO_BROWSER_CHANNEL=''` selects the bundled Chromium instead, which is what
the container and CI use)
against a throwaway copy of `apps/site`: its schema and views, a fresh SQLite
file, a known admin password (`tests/browser/serve.ts`). It is not part of
`bun test` or `bun run check`; specs are `tests/browser/*.browser.ts`. The
site also gets an "Every editor" document type, generated at startup with a
property for every built-in data type, and a view that renders a crop of its
image picker. The suite shares that one site, so every test names what it
creates uniquely.

| Spec                          | What it drives                                                                                                                                                                                                                                                                                                                                          |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `content.browser.ts`          | the create dialog; create, save and publish; rich text kept across a reload; the Info tab; and the create dialog under a page offering that type's allowed children rather than the root set                                                                                                                                                            |
| `settings.browser.ts`         | a template added to a document type stays after save; a new template starts as a TSX view, a master template becomes its layout export, saves as TSX and reopens with its master; a new partial view starts from the TSX skeleton, and a stylesheet and a script save and are served; the log viewer's overview and search show the server's own events |
| `document-actions.browser.ts` | every action in a page's menu through its dialog: blueprint, notifications, hostnames, duplicate, move, sort, publish, unpublish, rollback, public access, trash, restore, delete, empty bin; save and preview; publish with descendants                                                                                                                |
| `media.browser.ts`            | every property editor renders and an upload saves; an image dropped in Media, picked on a page and in its rich text, published, and its crop served                                                                                                                                                                                                     |
| `users.browser.ts`            | a user created in the Users section and put in a group restricted to one branch; the group opened and saved; signed in, that editor sees only the way to their branch and is offered Create but never Delete. A dictionary item opened from the Translation tree and its translation saved                                                              |
| `login.browser.ts`            | an invitation link followed on our login page, a password chosen, and a sign-in; then "Forgotten password?", the reset link, a new password and a sign-in                                                                                                                                                                                               |
| `library.browser.ts`          | the Library section: Create offering the site's element types and not just Folder, then an element named, filled, published, and appearing in the tree; and the workspace hint that an element type is not in the Library until that flag is on, silent for one that is and for an ordinary document type                                               |
| `variants.browser.ts`         | a page that varies by culture written and published in English, then switched to Danish and published through the publish dialog; each rendered under its path-prefix hostname, Danish falling back to English                                                                                                                                          |

### In the pipeline

The suite is a CI job of its own, and the only one that does not run every time: it
takes ~7 minutes at one worker and is the most runner-sensitive thing here. On `main`
it runs when the commit message contains `--browser-tests`; on a tag push it always
runs, because `release.yml` calls `ci.yml` with `browser_tests: true` and nothing
should be published without it. Pull requests never run it.

Three settings exist for CI specifically. `retries: 2` applies only when `CI` is set,
so a flake on a laptop stays a flake worth chasing rather than being retried away.
`forbidOnly` stops a stray `test.only` turning a green build into one test. And the
HTML report and traces upload as artefacts on failure — a CI-only failure cannot be
diagnosed without them, since the run and its screenshots are gone.

The job installs Chromium onto the runner rather than running inside Playwright's
image, because every other piece of it is one the existing jobs already prove works.
Chromium rather than Chrome also means a CI failure reproduces anywhere with
`bun run docker:test:browser`, Apple silicon included, where Chrome has no Linux
build to install at all.

The browser site also has a "Variant page" type that varies by culture, allows
password resets, and records the invitation and reset links it would have
e-mailed in `output/browser-links.jsonl`, which `login.browser.ts` follows.

Cancelling a dialog makes the client log `Error executing action: {type:
close}` (or `undefined`); the specs that cancel allow those by name.

Two rules keep the suite deterministic. **A test leaves no site-wide state
another depends on**: names and hostnames are unique per run, and a blueprint a
test creates it deletes, so every test passes rerun against the same site
(`--repeat-each`). **Nothing is driven before the backoffice has settled**:
`signIn` and `goToSection` wait for the section to finish rendering, because
Umbraco's client throws from its own code ("Tree context is not set",
"context.provideAt is not a function") when a section is left mid-render, and
clicking the open section's tab navigates again, closing any dialog a test
opens next. Both were found by running the suite repeated under CPU load, which
is how a change to it should be checked.

Every test records what the browser saw (`tests/browser/fixtures.ts`) and
fails on any of it: a console error, an uncaught exception, a request that
failed, or a Management API response of 4xx/5xx. Those are the failures that
leave the backoffice on a spinner with nothing in the server log — the
reason the suite exists, and what catches a regression when the vendored
backoffice is upgraded. The client's speculative token refresh on first load
is allowed by name (Umbraco answers the same 400). A request Chrome reports as
aborted is ignored when the server answered it below 400: the client never
reads an empty (`Content-Length: 0`) body, such as validate's 200 or create's
201, and the login page navigates away on its 200; both look aborted, and are
the same against Umbraco.

Failures keep a trace (`bunx playwright show-trace <trace.zip>`: every step
with DOM snapshots, network and console) and a screenshot under
`output/browser-results/`; the HTML report is `output/browser-report/`. Video is
off — it needs Playwright's ffmpeg download, and the trace carries a
screencast.

The first run found five defects in minutes, none visible to `bun test`: the
Lato fonts the UI library's themes load were never vendored; `data-type/batch`
returned a bare array where the contract says `{ total, items }`, and
`item/data-type` lacked `editorAlias` — together the document editor's
endless spinner; tree ancestors answered 400 for a missing id where Umbraco
answers `[]`; and the live-update WebSocket (`/umbraco/serverEventHub`) did not
exist.

The next session found three more. The seeded rich text data type named
`Umb.PropertyEditorUi.RichText`, a UI the client does not register — Umbraco
seeds `Umb.PropertyEditorUi.Tiptap` with its configuration — so every rich
text property showed "The configured property editor UI could not be
found"; migration 009 corrects existing databases. With that fixed, Tiptap
crashed on load: vendoring built each bare dependency separately, so every
`@tiptap/extension-*` carried its own copy of `@tiptap/core` and ProseMirror,
which refuses to mix copies; they are now bundled in one split build.
`expectEveryPropertyEditorRenders` waits for every property's editor and
rejects the missing-UI placeholder, which never reaches the console.

Save and publish then showed Umbraco's re-login dialog, which threw
`_subject is undefined` on sign-in — an upstream 18.2 race in which both the
dialog and the login view close it. The dialog was the real symptom: every
start reset the admin password and ended all sessions, even when the password
was unchanged, so a watch-mode restart signed open tabs out. An unchanged
password now keeps sessions, and `start:local:watch` passes `--keep-admin`.
The second test saves and publishes a page and checks it renders at its URL.

The create dialog under a page listed only the root types: `item/document`
answered an empty document type id, so the client asked for types allowed at
root instead of the parent type's allowed children. Items now carry the type
and each variant's real state.

Rich text vanished on its second save. Values were stored as JSON text but
returned as that text; the editor copies its value with an object spread, which
turns a string into one key per character, and saved that. Structured editors
now get parsed values, and stored spread strings are repaired as they are read.
The second test types into the rich text editor, checks the published page, and
reloads to check the editor shows what was saved.

The page's Info tab asked for five operations that did not exist: the audit
log, references, redirects, redirect status, and user names for the history.
The audit log now comes from the page's versions, which record who made them.
References and redirects answer empty until relations and redirect tracking
exist. The second test now opens the Info tab.

A template added to a document type vanished on save. The client caches
entity details while connected to the event hub and clears an entry only when
a server event names it, and the hub never sent any. Every change now
announces itself. `settings.browser.ts` adds a template, saves, and checks it
is still shown; it fails with the events turned off.

`tests/vendor.test.ts` pins both for upgrades, without a browser: every
built-in data type names a UI the vendored client registers, the theme
fonts are present, and ProseMirror is vendored exactly once.

## Manual checklists

Browser tests run only when asked; each Phase 6 work package instead ends
with a checklist to walk in the real backoffice (`bun run start:local`).

While walking one, watch the server console: in development every operation
the backoffice asks for that still answers 501 is logged once, with its id,
method and path, and a running count.

**WP-6.1 — document workspace**

1. Content → create a Home Page under the root; leave Title empty; *Save and
   publish* → the Title field is marked "A title, please" and nothing appears
   in the tree.
2. Fill Title, *Save and publish* → a success toast, the page in the tree,
   rendered at `/`.
3. Reload the browser deep-linked to the page's edit URL → the workspace opens
   and the tree is expanded to it.
4. Edit Title, *Save* → Info tab shows "Published, pending changes"; the site
   still renders the old title; *Save and publish* → the new one.
5. The Recycle Bin node opens without an error toast; trash the page → it is
   listed there.

**WP-6.2 — Settings section**

1. Settings opens with no error toast; every tree expands (Partial Views,
   Scripts, Stylesheets, Dictionary, Media Types, Member Types are empty).
2. Document Types → create a folder "Pages"; inside it a type with a tab,
   three properties on three editors — one via *Select editor → create a new
   data type* — a composition, an allowed child, and *Create template* on.
   Save → `schema/document-types/<alias>.toml` has `folder = "Pages"`, the
   data type's file is in `schema/data-types/`, the view in `Views/`.
3. Reload → the tree shows the folder and the type; the Compositions tab lists
   the other types with their folder paths; the Templates tab shows the new
   template as default.
4. Rename the folder → the type's file follows; move the type to the root →
   the `folder` key disappears; delete the folder.
5. Languages → add Danish with English as fallback → `schema/languages.toml`
   lists both; delete English → refused (Danish falls back to it).

**WP-6.6 — variants and localisation**

1. Settings → Languages: add Danish, falling back to English. Settings → a
   document type: *Allow vary by culture*, and on its Title property too.
2. Content → create a page of that type in English, *Save and publish* → the
   dialog offers English only (Danish is not created); publish.
3. Switch the workspace to Danish, name it, leave Title empty, *Save and
   publish* → choose Danish only.
4. *Culture and Hostnames* → `localhost:8080/en` English, `localhost:8080/da`
   Danish → `/en/` shows the English page, `/da/` the Danish name with the
   English title (a view using `fallback: 'language'`).
5. Edit the English title, publish Danish only → `/en/` still shows the old
   title; the English variant reads "Published (pending changes)".
6. Translation → create a dictionary item with both translations; export it,
   delete it, import the file → it is back.

**WP-6.7 — users and groups**

1. Users → create a user in Editors → the dialog shows a first password; the
   user signs in with it in another browser.
2. User Groups → create a group with Content only, a start node on one branch
   and no Delete; put the user in it → signed in again, they see only the way
   to the branch, no Delete in its menu, and the Recycle Bin is empty.
3. Their profile → change the UI language to Danish → the backoffice follows.
4. As the administrator, disable the user → their open session ends; enable
   and unlock them.
5. With `sendUserLink` unset in production the Invite button is hidden; in
   development *Invite* prints the link to the console, which opens our login
   page to choose a password.

**Module graph** — two layers, because resolution and linking fail differently.

`tests/boot.test.ts` walks every module reachable from the backoffice entry point
through the served import map and asserts nothing 404s: 6,556 modules in under a
second, in-process (`createServer()` returns the fetch handler, so no port is
bound).

`check:modules` then verifies the graph the way a browser links it — every named
import really exported, `export * from` chains followed, every module valid ESM.
A module can resolve, serve a 200, and still refuse to link; that is exactly what
happened with `deps/uuid/index.js`, and only this layer caught it.

Neither is a substitute for a browser: they prove resolution, content types and
linkability, not the absence of runtime errors.

Browser/UI tests are out of scope unless explicitly asked for; the backoffice is
upstream's code and upstream tests it (423 `*.test.ts` under web-test-runner, plus
Playwright e2e against MSW mocks).

## Phase 0 coverage

Phase 0 ships behaviour, so it ships tests. Specifically:

- **contract loading** — the vendored `OpenApi.json` parses; path, operation and
  schema counts match the recorded expectation (428 / 513 / 507), so an
  accidental re-vendor from a different version fails loudly
- **route table** — every operation in the spec resolves to a handler or an
  explicit `501` stub; no operation is unroutable; no duplicate operation ids
- **router** — path matching including `{id}` params and the `v1.1` route;
  unknown paths 404 as Problem Details
- **cross-cutting middleware** — `Umb-Notifications` present on non-GET and absent
  on GET; Problem Details shape with `type: "Error"` and `operationStatus`;
  `skip`/`take` validation returning 400 when skip is not a multiple of take;
  camelCase and string-enum serialization
- **dialect seam** — the same migration runs on SQLite and Postgres; the schema
  self-check passes on both; the lock abstraction serialises two concurrent
  writers
- **packaging** — every published manifest carries the metadata npm needs and an
  `exports` map whose targets exist on disk; one version across the set, the
  vendored client excepted; and `bun.lock` agrees with the manifests, because
  `bun pm pack` resolves `workspace:*` from the lockfile and not from the
  manifest — a mismatch publishes packages pinned to a version nobody released
- **vendoring** — `packages/backoffice-dist/dist/` has the expected entry points, the
  generated import map resolves `@umbraco-cms/backoffice/*` to files that exist,
  and no bundled `external/*` file contains an unresolved bare import

That last one is the test that would have caught R3 before it cost a day.

## Working directories

Each test builds a throwaway site with `mkdtemp` under `output/`, and `mkdtemp` does
not create parent directories. `tests/support/db.ts` creates `output/` at module
scope: every test that needs a site directory reaches that module, directly or
through `harness.ts`, and an import is evaluated before the importer's body, so
there is no test that can need the directory without passing through the code
that makes it. The browser suite's server does the same for itself in
`tests/browser/serve.ts`.

Without that, the suite passes on a machine that has run it before and fails ~50
tests with `ENOENT` on a fresh checkout — which is exactly what a CI runner is. It
is deliberately not a `bunfig.toml` preload: a root config file is one `git add`
away from being left out of a commit, and then the suite fails only on CI.

`bun test` also **scans `output/`**, so a `*.test.ts` left there by hand is
collected and run alongside the suite. The generated site directories hold no test
files, so this never bites the suite itself, but a throwaway reproduction written
into `output/` will keep failing every run until it is deleted. Worth knowing
before spending time on a failure that belongs to nothing.

**An interrupted Postgres run used to poison the database.** `resetPostgresSchema`
drops `public` and recreates it; a run killed between the two leaves the database
with *no schemas at all*. `connect()` issues `CREATE EXTENSION IF NOT EXISTS citext`
on every Postgres connection, and that needs a schema on the search_path to put the
extension in — so every later run failed at *connect*, before reaching the code that
would have recreated the schema, with 240-odd "no schema has been selected to create
in" errors and no way out but `psql`. `tests/support/db.ts` now ensures `public` on a
connection of its own before calling `connect()`, so a Ctrl-C is survivable. Worth
knowing that the same shape exists in the product: a Postgres database whose
`public` schema has been dropped cannot boot bunbraco, and says so obscurely.

The suite also wants `packages/backoffice-dist/dist/` present. About twenty tests
skip themselves without it and the cache-busting hash test fails outright, so CI
builds the client in its own job and the test jobs restore it from the cache
rather than running against a missing one.

## Status

**554 tests, green on both SQLite and Postgres** (a few are dialect-specific and skip on the other), plus 22 browser tests.

Defects the suite found while being written — the case for running both dialects
from the start rather than porting later:

- Postgres `SET search_path` does not survive Bun's connection pool, so tables
  leaked into `public` and state bled between tests. Fixed by resetting the
  `public` schema per test, which also means Postgres test files must not run
  concurrently against one database.
- Postgres refuses to infer a type for a parameter used only in `? IS NULL`, so
  that query is now built conditionally instead.
- The lock test asserted one exact ordering of two concurrent writers, so it
  failed on Postgres whenever the second writer won the advisory lock — a real
  race between the acquirers, not a failure to serialise. It now accepts either
  order and still rejects interleaving. An assertion that over-specifies is the
  same defect as one that under-specifies: both report the wrong thing.
- **Postgres normalises `uuid` values to lowercase on read while SQLite stores
  text verbatim**, so the uppercase object-type constants never matched on
  Postgres. Everything now goes through `normaliseUuid`.
- The import map advertised monaco after monaco failed to bundle — a dangling
  entry that fails at runtime with an opaque module-resolution error.
- The module-graph crawl found 27 bare specifiers with no import-map entry plus a
  missing `package.json`, none of which a unit test would have noticed.
- A relative views directory broke dynamic `import()` of templates, because a
  relative specifier resolves against the importing module, not the working
  directory.
- **Bun tree-shook `uuid`'s re-export barrel** down to an export clause whose
  bindings did not exist, so the browser refused to link it and the whole
  backoffice failed with `Export 'A' is not defined in module`. The module
  resolved and served a 200, so the resolution crawl saw nothing wrong — this is
  why `check:modules` validates bindings, not just resolution.
- `packages/sysinfo` imported a JSON module without an import attribute, by a
  relative path that escaped the served root.
- **Servers left running between test files.** `boot.test.ts` never closed its
  server, and `auth.test.ts` closed only the database, not the server. Their
  cache pollers kept registering a stale node in whichever schema the shared
  Postgres database held next, which now and then made another file's production
  boot see a node that was not there. Every test now closes the whole server
  (`server.close()`: jobs, poller, watcher, then the database).

## The consumer test

The suite runs inside the workspace, where the root depends on every package, so
it cannot see what breaks for a site that depends only on `bunbraco`. 5a's exit
test is therefore a directory outside the repo: `bun link bunbraco`, `bunbraco
init`, a view, boot, sign in, create a type and a page through the API, render.
It found a JSX import-source name that resolved everywhere except from a real
site. Until it is automated, it is the manual gate for any change to package
boundaries, `exports`, or dependencies.

## The signed-in harness

`tests/support/harness.ts` boots the real application and completes the whole
OAuth flow — login, authorize, code exchange — then carries cookies, so a test
calls the Management API exactly as the backoffice does. Nothing is stubbed: the
Phase 3 and Phase 4 suites exercise the same code path a browser would.

Because the harness boots a server per test, each one must close its database
(`afterEach`), or Postgres runs out of client slots.

## Running the tests

Every test command comes in two forms: on the host, and the same suite inside a
container over the mounted source.

| On the host             | In Docker                      | Runs                                                                |
| ----------------------- | ------------------------------ | ------------------------------------------------------------------- |
| `bun test`              | `bun run docker:test`          | the default dialect, SQLite                                         |
| `bun run test:sqlite`   | `bun run docker:test:sqlite`   | SQLite, pinned; starts no database                                  |
| `bun run test:postgres` | `bun run docker:test:postgres` | Postgres; brings the `db` container up itself                       |
| `bun run test:all`      | `bun run docker:test:all`      | both dialects in sequence — **the real gate**                       |
| `bun run test:browser`  | `bun run docker:test:browser`  | the Playwright suite; Chromium in the container, Chrome on the host |
| `bun run test:integration` | `bun run docker:test:integration` | the CLI end to end — creating a site, content transfer, the server roles and the upgrade; `bun test` does not collect these |

Each container service takes a command override, so a single file is
`docker compose run --rm cms-test-sqlite bun test tests/redirects.test.ts`.

The host and container runs set identical environments, from one anchor in
`compose.yaml`, so they test the same thing. The container is slower — the source
is a bind mount, which costs roughly 50% on macOS — so the host commands are the
ones to use while working, and the Docker ones when you want to know it passes
somewhere other than your machine.

`test:ci` is the one command with no twin, on purpose: it exists so the CI workflow
can supply the dialect through job environment, and in a container the dialect *is*
the service you pick, so `docker:test:sqlite` and `docker:test:postgres` together
are that matrix.

The browser suite has its own image (`docker/Dockerfile.browser`): Playwright's
official image, which pins the browser system libraries to the Playwright version,
with Bun copied in to run the server under test. Its tag must track the
`@playwright/test` version, and `tests/docker.test.ts` fails if it drifts. It also
gets its own `node_modules` volume, because that image is Debian and the CMS image
is Alpine — one install cannot serve both. **One behaviour differs there**: the host
run drives installed Google Chrome (`channel: 'chrome'`), and the container cannot,
because Google publishes no Linux arm64 build of Chrome. The container sets
`BUNBRACO_BROWSER_CHANNEL=''` and gets Playwright's bundled Chromium instead.

The suite drops and recreates the `public` schema between servers, so it is given
a database of its own: the stack provisions `bunbraco` for the CMS and
`bunbraco_test` for the tests. The CMS container can stay up during a test run
without the two colliding. Don't run a host and a container Postgres suite at the
same time, though — they share that one database.

The Postgres runs use `--timeout 20000`. They are roughly four times slower than
SQLite's private in-memory databases and every test boots a server — migrations,
then a seed — so several sit at one to two seconds. Bun's 5s default leaves too
little headroom, and the heaviest tests time out when the host is busy rather than
when anything is wrong. The SQLite runs keep the default.

Both dialects are exercised from day one, and it has paid for itself: it caught
`SET search_path` not surviving Bun's connection pool, Postgres refusing to infer
a type for `? IS NULL`, and — the subtle one — Postgres normalising `uuid` values
to lowercase while SQLite stores them verbatim.

Individual Postgres tests **skip** rather than fail when no server is reachable,
so a clone without Docker can still run `bun test` and `test:sqlite` and is never
blocked. A skip is not a pass, though: `test:all` is the gate. To point at a
Postgres of your own instead, set `BUNBRACO_POSTGRES_URL` and run `bun test`
directly with `BUNBRACO_DB=postgres`.

## How the test containers work

`compose.yaml` holds Postgres, a single-node CMS, and one service per test shape.
Anything larger than a single node — an editor and a pool of renderers behind a
balancer — belongs to the enterprise distribution.

The three test services sit behind the `test` profile, so `docker compose up`
never starts them; they run only when a `docker:test:*` script asks for one.
`cms-test-sqlite` is built from an anchor that carries the image and the mount but
no `depends_on`, so a SQLite run starts no Postgres at all — whereas `cms-test`
declares the database and `docker compose run` brings it up and waits for its
health check.

`db:up` deliberately does **not** tear anything down: `test:postgres` calls it,
and a test run is meant to leave anything else you have running alone. Postgres
is on `localhost:5433` rather than 5432, which is normally a local install, so the
stack stays clear of one.

Running a single Postgres test file, override the command **with the timeout**:

```sh
docker compose run --rm cms-test bun test --timeout 20000 tests/users.test.ts
```

`docker compose run` replaces the service's `command`, so omitting it silently
drops back to bun's 5s default — which most Postgres tests in this suite cannot
meet.

The teardown passes `--remove-orphans`, which also clears the one-off containers
`docker compose run` leaves behind when it is interrupted: every `docker:test:*`
script uses `run`, and a plain `down` does **not** remove those. A survivor keeps
its old environment, so it will happily answer `docker compose exec` and `logs`
with stale values long after the compose file changed. It names the `test` profile
for the same reason `down` needs one at all — `docker compose down` acts on the
**active profile selection only**.

The repository is **bind-mounted** at `/app` rather than copied into the image, so
an edit on the host is visible in the container, in `packages/**` as much as in
`apps/site`. The image itself holds only the Bun runtime and the entrypoint, so it
is rebuilt only when `docker/Dockerfile.cms` or the entrypoint changes.

`node_modules` is the exception: it is a named volume, not part of the mount,
because the host's install holds macOS binaries that cannot run in the container.
The first boot populates it with `bun install --frozen-lockfile`.

The browser suite has an image of its own, because it needs browsers and because
that image is Debian where the CMS image is Alpine — one install cannot serve
both, hence a second `node_modules` volume. Its Playwright tag must match the
`@playwright/test` the project installs, which `tests/docker.test.ts` asserts.

One thing worth knowing about `output/`: the test services put their views, media
and logs there, and `output/` is inside the mounted repository — so anything else
running under `bun --watch` against the same checkout sees every file a test run
writes as a source change. When the dev server and a suite shared a checkout this
way, the SQLite suite went from 140 seconds to **1,834**, and Postgres from five
minutes to **three and a half hours**, with tests failing on timeouts that had
nothing wrong with them. Worse, a timeout landing inside `resetPostgresSchema`
left the database with no `public` schema and every later file failed with `no
schema has been selected to create in`. The reset is one transaction now, so an
interrupted one rolls back instead of cascading.

---
