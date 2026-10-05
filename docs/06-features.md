# Feature inventory

Derived from the Umbraco 18 repo: the 428-path Management API surface, the
`src/` project set, and the backoffice's shipped extension manifests.

Endpoint-group sizes below come from `contracts/OpenApi.json` (path counts):
`tree` 57, `item` 43, `user` 32, `document` 28, `recycle-bin` 27, `element` 21,
`document-type` 20, `media-type` 17, `media` 15, `member-type` 15, `data-type` 12,
`document-blueprint` 8, `log-viewer` 7, `member` 7, `partial-view` 7,
`package` 6, `dictionary`/`script`/`server`/`stylesheet`/`template`/`webhook` 5 each,
`filter` 4, `document-version` 4, `element-version` 4, `security` 4, and a long
tail of 1–3 each.

---

## Must have — core CMS

### Boot & install
- Install wizard (`install`), upgrade/state (`upgrade`), `server/status|information|configuration`
- Schema creation and migration-state tracking (Umbraco: `umbracoKeyValue` + migration locks)
- Write locks around content-tree mutation (SQLite single-writer queue; Postgres advisory locks)

### Auth & security
- OAuth 2.0 authorization-code + PKCE server issuing **reference tokens**, stored
  in `__Host-`-prefixed HTTP-only cookies and redacted from JSON bodies (Umbraco
  v17+ behaviour; the client sends `credentials: include`)
- Backoffice login/logout, token refresh and revocation, password reset, invite acceptance
- `security/back-office/graphics/*` — logo/background images the login shell references
- Per-user MFA/2FA (endpoints must exist; full implementation is a could-have)

### Users & user groups
- User CRUD, invite, enable/disable/unlock, avatar, `user/current` + resolved permissions
- User groups: granular permissions, allowed sections, content/media start nodes, languages
- `user-data`, current-user configuration

### Document types (content types)
- CRUD; alias, icon, description; folders and tree organisation
- Property types and property groups (tabs/groups) with sort order
- Composition/inheritance, allowed child types, allowed-at-root
- Variance flags: culture-variant and segment-variant, at type *and* property level
- Allowed templates + default template; **element types**; list-view configuration

### Data types & property editors
- Data type CRUD + folders, configuration values, references/usage
- Server-side value storage, validation and conversion for the core property editors:
  TextBox, TextArea, RichText, Numeric, Toggle, DateTime, Dropdown, Radio/Checkbox
  list, ColorPicker, EyeDropper, Slider, Tags, Label, ContentPicker,
  MultiNodeTreePicker, MediaPicker3, MemberPicker, MultiUrlPicker, ImageCropper,
  UploadField, MarkdownEditor, CodeEditor, EmailAddress, BlockList, BlockGrid
  (exact alias set confirmed against the client's manifests during Phase 3)

### Documents (pages)
- Tree (`children`/`root`/`ancestors`), item lookups, collection/list view
- Create, update, validate, delete; move, copy, sort
- **Publish/unpublish per culture**, publish-with-descendants, scheduled release/expire
- Draft vs published storage; **version history, rollback, `preventCleanup`**, version cleanup
- Recycle bin (trash/restore/empty)
- Domains and culture hostnames; public access (protect by member group/login)
- Blueprints (content templates), notification subscriptions, audit log, references/usage
- The `Umb-Notifications` response header convention. Umbraco has **no** ETag/If-Match
  anywhere — last write wins; do not invent concurrency tokens the client will not send

### Templates & static files
- Templates (views) CRUD with master-template chain; partial views; stylesheets; scripts
- File-tree endpoints for each, backed by `apps/site/Views` and friends

### Rendering
- Published-content cache (published only), invalidated via publish notifications
- URL-segment generation, hierarchical routing, culture/domain routing, URL aliases
- TSX template execution with an Umbraco-shaped model: `value()`, `children`,
  `ancestors`, `parent`, culture fallback
- Preview (render drafts for an authenticated editor); `NotFound`, `NoNodes`, maintenance pages

### Media & media types
- Media type CRUD; media tree and collection; temporary-file upload → media creation
- File-storage abstraction (local disk first); image resize/crop URLs; focal point

### Members (federated)
- Member types, member groups, member CRUD and search in the backoffice
- Front-end member authentication (login/logout/register), password hashing
- **External identity providers** (OIDC/OAuth) with linked external-login records and auto-link rules
- Public-access enforcement in the rendering pipeline

### Localisation
- Languages/cultures CRUD, default and fallback language
- Dictionary items (tree + CRUD); backoffice UI localisation files served to the client

### Cross-cutting
- Relations and relation types; tags; redirect management (URL tracker)
- Backoffice search: `searcher`, `indexer`, `filter` over FTS5/`tsvector`
- Package manifest discovery (`manifest/*`) so installed npm extensions and the core manifest reach the client ([`17-packages.md`](17-packages.md))
- Created packages: exporting a slice of the site — schema, files, content, media — as a zip, and backoffice extensions installed as npm dependencies ([`17-packages.md`](17-packages.md))
- Background jobs: version cleanup, scheduled publishing, temp-file cleanup, log scrubbing
- Notification/event bus decoupling publishing, caching, indexing and webhooks

---

## Could have — high value, after core

- **Delivery API** (`/umbraco/delivery/api/v2/**`) with API-key and preview auth
- **ModelsBuilder equivalent**: generate TypeScript types per document type so TSX
  templates are type-safe end to end. Natural fit for this stack; a differentiator.
- SignalR-compatible server-events channel (the client peer-depends on
  `@microsoft/signalr`) for live tree refresh and user notifications
- Log viewer, health checks, telemetry, profiling, published-cache admin endpoints
- Webhooks (events → HTTP) with a delivery log
- Content segments (A/B, personalisation); dynamic root pickers
- oEmbed proxy; `help` and `news-dashboard` dashboards
- Email sending (invites, resets, notifications) — several must-have flows degrade
  gracefully without it, so it is deliberately not a blocker
- Bulk actions, tree drag-and-drop refinements, audit-trail UI
- Multi-server operation: shared cookie encryption keys, distributed cache notifications
- Postgres tuning: pooling, read replicas

---

## Out of scope for now

- Compatibility with Umbraco's own package ecosystem; Razor and AngularJS-era
  compatibility. Backoffice extensions of our own are npm dependencies
  ([`17-packages.md`](17-packages.md)); an Umbraco package does not install here
- ModelsBuilder DLLs, Examine/Lucene, ImageSharp
- Umbraco Cloud/Deploy, Forms, Commerce
- SQL Server
- Opening an existing Umbraco database in place — a one-way importer does that
  instead, see [`16-umbraco-import.md`](16-umbraco-import.md)
