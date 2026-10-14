# Roadmap

Where the project is going, the risks it carries, and where it departs from
Umbraco on purpose. The work itself — built, in progress and planned — is in
[`stories/`](stories/README.md), one story per deliverable, each with its own
acceptance criteria. A story is done when it works in the actual Umbraco
backoffice, never when an endpoint merely returns 200.

## Where this is going

Decisions taken after the vertical slice (story `005`) reshape the project, and they are designed
before any more code lands:

- **Schema is code.** Content types, data types and languages live in
  `schema/*.toml` in the site's repo; the database caches them. The backoffice
  type editor writes the files. Comments are stripped on write; `description` and
  `notes` fields survive instead.
- **A site installs `@crombolo/crombolo`.** Done in story `010`: the composition root lives in
  `@crombolo/server`, the built backoffice in `@crombolo/backoffice-dist`, every
  package declares its dependencies and an `exports` map, and there are no
  tsconfig `paths` anywhere. A directory outside this repo with `bun add
crombolo`, a config file and a three-line `server.ts` boots the backoffice and
  renders a page.
- **Metadata promotes through environments the way code does.** A schema
  change moves dev → test → production as files; when it needs data moved, a
  value migration in `schema/migrations/` is written once and runs in every
  environment against that environment's content. Removing a property never
  deletes its data — it is retired, and reintroducing the field brings the
  values back. A framework upgrade is the same process with one more source of
  change.
- **Changes are proven and prepared before they run.** Schema migrations are
  expand/contract with a ledger and a `--plan`. `crombolo upgrade check` reports
  what a release needs from the data — auto-fixable, needs a person, or blocking
  — and `check --fix` applies the additive part on the live site, so a new
  required field appears in the backoffice to be filled in before the deploy.
  `crombolo upgrade` refuses until the check is clean. Values are append-only
  and tagged with the schema state that wrote them, and only a node at the
  current state may write — so old nodes keep serving reads through a rolling
  deploy and there is never a maintenance page. Production never auto-upgrades.

Details in [`schema-as-code.md`](schema-as-code.md) and
[`packaging-and-upgrades.md`](packaging-and-upgrades.md); the work was stories
`010`–`015`.

What is **not** built yet is a story, ranked in the delivery order of
[`stories/README.md`](stories/README.md), measured rather than remembered:
`bun run coverage:api` reports the contract side
([`api-coverage.md`](api-coverage.md)), and the stories name what the contract
does not cover — content notifications, search over property values, the
Delivery API, external identity providers. The divergences that are deliberate
rather than missing are listed below.

## Deliberate divergence, not gaps

Listed so they are not mistaken for gaps:

- The **install wizard** (3 ops) and the **upgrade endpoints** (2) answer 501 on
  purpose; `crombolo init`, schema-as-code and `crombolo upgrade` replace them.
  The real consequence is that there is no first-run browser experience, so a
  non-developer cannot stand a site up.
- The **template query builder** writes TypeScript against the render model rather
  than Razor (story `021`).
- **Telemetry** is fixed at Minimal and cannot be raised: nothing is collected or
  sent. **Profiling** is off and cannot be switched on: there is no profiler.
  **Help** pages are an empty list: Umbraco relays them from our.umbraco.com.
  [`diagnostics.md`](diagnostics.md).
- `coverage:api` lists each operation still answering 501 as a deliberate
  divergence, with its reason, or by the story that builds it
  ([`api-coverage.md`](api-coverage.md)).
- **Segments** round-trip but no provider ships, so personalisation is inert —
  exactly Umbraco's behaviour without a package.
- **snake_case** rules out importing an existing Umbraco database, **every save is
  a version** (Umbraco versions only on publish), and **rollback appends**.
- **Load balancing** goes through `cache_instruction` polling rather than
  Umbraco's distributed cache, and tokens are hashed database references, so
  there are no data-protection keys to share.


## Risks

**R1 — Contract fidelity.** 513 operations, and the client fails in
hard-to-diagnose ways on small shape mismatches. *Mitigation:* generate types from
the spec so drift is a compile error; validate every response against its schema
in test mode; consult `Umbraco.Web.UI.Client/mocks/` (an MSW mock server covering
~45 endpoint groups) whenever the schema is ambiguous.

**R2 — The login SPA is not on npm.** `src/Umbraco.Web.UI.Login` is private and
its build reaches into the client's source tree. *Resolution:* write our own login
page against the same token endpoints; the `<umb-auth>` contract is small.

**R3 — npm ships a non-runnable client.** *Resolved in story `001`* — see
`backoffice-hosting.md`. `bun build` reconstitutes the `external/*` bundles,
UUI themes come from npm, and seven small static files come from the Umbraco
source tree.

**R4 — SQLite write concurrency.** Umbraco relies on DB-level locks around
content-tree mutation. *Mitigation:* WAL plus a single-writer queue on SQLite,
advisory locks on Postgres, both behind one lock abstraction from story `001`.

**R5 — Reference-token semantics.** The client must never be made to call
`validateToken()` per request — it revokes the previous reference token and the UI
logs itself out at random. Our token store must match Umbraco's rotation
semantics.

**R6 — Monaco's web workers. Resolved in story `002`.** A Bun bundler plugin
translates Vite's `?worker` and `?inline` import suffixes, and each monaco worker
is built separately. All 10 externals now bundle.

**R7 — The npm package contains build-time files.** `vite.config.js`,
`openapi-ts.config.js` and test helpers ship in the tarball and import build
tools, which is indistinguishable from a missing runtime dependency when scanning
imports. *Mitigation:* prune them from the served tree during vendoring, so the
scan only sees runtime code.

