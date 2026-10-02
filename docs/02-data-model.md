# Data model

Umbraco's relational model, semantics preserved exactly, names in snake_case.
Verified against `Umbraco.Infrastructure/Persistence/Dtos/*.cs` (81 DTOs — NPoco
attributes make the DTOs *the* schema) and
`Migrations/Install/DatabaseSchemaCreator.cs`.

## Naming

Umbraco's prefixes are historical accident (`umbraco*` vs `cms*`) and carry no
meaning, so they are dropped. Singular, snake_case.

| Umbraco | Bunbraco |
| --- | --- |
| `umbracoNode` | `node` |
| `umbracoContent` | `content` |
| `umbracoContentVersion` | `content_version` |
| `umbracoDocument` / `umbracoDocumentVersion` | `document` / `document_version` |
| `umbracoPropertyData` | `property_data` |
| `umbracoContentVersionCultureVariation` | `content_version_culture_variation` |
| `umbracoDocumentCultureVariation` | `document_culture_variation` |
| `cmsContentType` | `content_type` |
| `cmsPropertyType` / `cmsPropertyTypeGroup` | `property_type` / `property_type_group` |
| `cmsContentType2ContentType` | `content_type_composition` |
| `cmsContentTypeAllowedContentType` | `content_type_allowed_child` |
| `cmsDocumentType` | `content_type_template` |
| `umbracoDataType` | `data_type` |
| `cmsTemplate` | `template` |
| `umbracoUser` | **`user_account`** — `user` is reserved in Postgres |
| `umbracoUserGroup`, `umbracoUser2UserGroup` | `user_group`, `user_group_member` |
| `umbracoUserGroup2Permission` | `user_group_permission` |
| `umbracoUserGroup2GranularPermission` | `user_group_granular_permission` |
| `umbracoUserGroup2App` / `2Language` | `user_group_section` / `user_group_language` |
| `umbracoUserStartNode` | `user_start_node` |
| `cmsMember`, `cmsMemberType`, `cmsMember2MemberGroup` | `member`, `member_property_type`, `member_group_member` |
| `umbracoExternalMember` | `external_member` |
| `umbracoExternalLogin`, `umbracoExternalLoginToken` | `external_login`, `external_login_token` |
| `umbracoLanguage`, `umbracoDomain` | `language`, `domain` |
| `umbracoKeyValue`, `umbracoLock` | `key_value`, `lock` |
| `umbracoAccess`, `umbracoAccessRule` | `public_access`, `public_access_rule` |
| `umbracoRedirectUrl` | `redirect_url` |
| `cmsContentNu` | `content_cache` *(deferred)* |
| `umbracoDocumentUrl`, `umbracoDocumentUrlAlias` | `document_url`, `document_url_alias` *(deferred)* |

## Schema tables are a cache

`content_type`, `property_type`, `property_type_group`, `data_type`, `language`
and their join tables are populated from the site's `schema/*.toml` files at boot
(`09-schema-as-code.md`). Their shape is Umbraco's plus two additive columns:
`since_version` (the deployment that created the row, for pending-element
gating) and `retired_at` (a property removed from its file is retired, never
deleted, so its values survive and return if it is reintroduced). The API no
longer writes these tables directly. `key` in a schema file is `node.unique_id`, which is why
tooling pins it before content can reference it.

## Values are append-only, and versions are events

This is the one place the model departs from Umbraco's tables, and it was
decided after Phase 4 was built on the Umbraco shape; 5b replaces the value
layer. The outer contract — trees, publish, the version list, rollback,
`prevent-cleanup` — is unchanged and the backoffice cannot tell.

**A value never changes in place. Every change appends a version, tagged with
the schema state current at the time.** Rollback appends versions carrying the
old values — the same git-revert semantics Umbraco already has for whole
documents, taken down to the property.

```
content_version                      the EVENT: save | publish | rollback | migrate
  id, node_id, kind, version_date, user_id, prevent_cleanup, text

property_value                       APPEND-ONLY; one row per changed value
  id, node_id, property_type_id, language_id, segment,
  event_id        -> content_version(id)
  schema_state_id -> schema_state(id)      the deployment that wrote it
  is_current                               maintained on insert; the hot-path read
  int_value, decimal_value, date_value, varchar_value, text_value, sortable_value

schema_state                         a HISTORY, one row per sync or upgrade
  id, version, revision, hash, status ('prepared' | 'current'), synced_at, synced_by
```

Reads are "latest per key", where the key is `(property, culture, segment)`:

| Need | Query |
| --- | --- |
| current draft | `is_current` — no as-of query on the hot path |
| published | latest per key with `event_id <=` the published event |
| a document version | latest per key with `event_id <=` that event |
| **as of a schema state** | latest per key with `schema_state_id <=` it — what an older node reads |

What follows from it:

- **Publish stops copying.** Umbraco freezes the draft and forks a copy of every
  property. Here publish is an event row and the `document_version.published`
  pointer. `edited` is "any value with `event_id >` the published event", so
  the diff query that recomputed it is gone.
- **Rollback appends.** For each value in the target version, a new version with
  that value, under a `rollback` event. History is never rewritten.
- **A value migration appends a converted twin of each value under the *same*
  event, tagged with the new schema state.** This is the detail that makes
  as-of reads work: the published read is "latest per key with `event_id <=`
  the publish event", and a twin with the same `event_id` and a higher `id`
  wins that query for a node at the new state — while the `schema_state_id <=`
  filter hands an older node the original. A migration therefore versions
  *values*, not documents: no document event is written, `is_current` moves to
  the twin for current rows, and history converts everywhere it exists. That is
  what makes rolling back a deployment safe without restoring a backup.
- **Retirement needs nothing.** A retired property's versions sit untouched;
  revival reads the latest.
- **Writes are inserts**, apart from the `is_current` flip on one row, which
  makes concurrent editing friendlier than in-place updates.
- **Cleanup** prunes non-current versions by the same keep-all-newer-than and
  keep-latest-per-day policy, and never prunes a version that a publish event
  pinned with `prevent_cleanup` still needs — the snapshot that event resolves
  to. That predicate is the one part more involved than Umbraco's.

Storage grows with *changes*, not snapshots — usually less than Umbraco's
per-publish full copy, but a busy editor makes rows, and the cleanup policy is
what keeps it bounded.

## Only a node at the current schema state may write

Every write transaction reads the latest `current` row of `schema_state` —
`FOR SHARE` on Postgres, trivially atomic on single-writer SQLite — and aborts
with 409 if the database's revision is ahead of the node's. `upgrade` takes the
same row `FOR UPDATE` to advance it, so a write either commits before the
cut-over or is refused after it; there is no race. A node that is behind keeps
**serving reads as-of its own state**; on its next cache-instruction poll it
switches itself to read-only and reports unhealthy, so what people see is a
paused editor rather than a failed save.

`check --fix` inserts a `prepared` state and tags the elements it creates early
with it; nodes gate on the latest `current` state, so the old nodes stay
writable while editors fill those elements in. `upgrade` flips `prepared` to
`current`: that one-row update is the cut-over.

## The two load-bearing decisions we keep

**1. `node` is a universal polymorphic tree.** Documents, media, members, all
content types, data types, templates, relation types, member groups and folders
are *all* rows in `node`, discriminated by `node_object_type`. This buys uniform
permissions, recycle bin, relations and `path`-prefix descendant queries. It is
the single most structural choice in the schema and we keep it, materialised
`path` column included.

**2. Values are typed columns selected by `data_type.db_type`**, now on
`property_value` rather than `property_data`. Collapsing them to one JSON column
on SQLite is tempting and wrong: it loses the typed indexes behind
`sortable_value`, date-range queries and numeric sorting. The key
`(property_type_id, language_id, segment)` is a value's identity across its
versions.

## Content types

```
content_type
  pk, node_id FK node(id)          -- node holds name/parent/path
  alias, icon, thumbnail, description
  list_view uuid NULL              -- key of a data type used as the collection view
  is_element, allow_in_library, allow_at_root  boolean
  variations smallint DEFAULT 1

property_type
  id, data_type_id FK data_type(node_id), content_type_id FK content_type(node_id),
  property_type_group_id NULL, alias, name, sort_order, mandatory,
  mandatory_message, validation_reg_exp, validation_reg_exp_message,
  description, label_on_top, variations smallint, unique_id uuid

property_type_group
  id, unique_id, content_type_node_id, type smallint,  -- Group=0, Tab=1
  text, alias, sort_order
```

**Two distinct hierarchies**, and conflating them is the classic mistake:

- `node.parent_id` on a content-type node — the **folder/container tree**
- `content_type_composition(parent_content_type_id, child_content_type_id)` — the
  **composition graph**, many-to-many

A type's effective property set is its own properties unioned with those of every
composition ancestor. Note that property groups belong to a *single* content type;
an inherited tab is materialised as a separate row on each composing type
(upstream abandoned propagating tab renames via a parent id).

**Variance** is a flags byte on *both* `content_type.variations` and
`property_type.variations`: `Nothing=0, Culture=1, Segment=2, CultureAndSegment=3`.
Effective variance is the **intersection** — a property varies by culture only if
its type does. This gates whether `property_data.language_id`/`segment` are
populated and whether the culture-variation rows exist.

## Users, permissions, members

Permissions come in three layers:

1. **Sections** — `user_group_section(user_group_id, section_alias)`
2. **Global permissions** — `user_group_permission(user_group_key, permission)`.
   In v18 these are verbs, not the old action letters: `Umb.Document.Read`,
   `Umb.Document.Update`, `Umb.Document.Publish`, `Umb.Document.Unpublish`,
   `Umb.Document.Delete`, `Umb.Document.Create`, `Umb.Document.Move`,
   `Umb.Document.Sort`, `Umb.Document.Rollback`, `Umb.Document.Notifications`,
   `Umb.Document.PublicAccess`, `Umb.Document.Permissions`, …
3. **Granular, node-scoped** — `user_group_granular_permission(user_group_key,
   unique_id, permission, context, entity_id)`. `context` discriminates
   `"Document"` / `"Element"` / `"DocumentTypeProperty"`, so one table holds both
   per-document ACLs and per-property-type field-level security.

Start nodes have two mechanisms, combined as Umbraco's `CombineStartNodes` does
(not a plain union — a user's own start node replaces a group's above or below
it): single-value columns on `user_group` (`start_content_id`,
`start_media_id`, `start_element_id`; `-1` is the root, null none) and
multi-value `user_start_node(user_id, start_node, start_node_type)` (1
content, 2 media, 3 element; `-1` the root). The verbs on a node are
calculated per group — the nearest node on its path the group sets
explicitly replaces the group's defaults — then unioned over groups. A
document's explicit setting is one row per verb, or one empty verb for
"nothing here"; a property's is keyed by its document type, with the verb
written `<property type key>|<verb>`, exactly as Umbraco stores both.

A **member** is a node facet, exactly like a document: `node` + `content` +
`content_version` + `member`. Member groups are plain `node` rows with the
MemberGroup object type — no separate table. Custom member fields go through the
ordinary `property_type`/`property_data` machinery.

**Federated members.** `external_login` is deliberately polymorphic —
`user_or_member_key uuid` serves both back-office users and members, with
`UNIQUE (login_provider, user_or_member_key)` and a lookup index on
`(login_provider, provider_key)`. `external_login_token` holds per-login tokens.
`external_member` (new in 17.4) covers federated members that are *not* content
nodes. This is the whole of the "federated member catalog" requirement.

**Password hashing.** Umbraco stores ASP.NET Core Identity v3:
`base64(0x01 | prf | iterations | saltLen | salt | subkey)`, HMAC-SHA512, 100k
iterations, plus a long legacy verification chain. Since we are not reading
existing Umbraco databases, **use argon2id** (Bun has `Bun.password`), and keep
the `password_config` JSON marker column so the algorithm is recorded per row and
can be rotated. Table shape is unchanged.

## Dialect strategy

Both dialects are implemented from day one behind one seam. The differences that
actually matter:

| | SQLite | Postgres |
| --- | --- | --- |
| Strings | `TEXT COLLATE NOCASE` — this is how Umbraco's pervasive case-insensitive alias/name comparison works | default collation is case-**sensitive**; use `citext` or `lower()` expression indexes on `alias`, `login`, `email`, `login_name`, `url_segment` |
| Booleans | `INTEGER` | `boolean` |
| UUID | `TEXT` (upper-case, as Umbraco does) | `uuid` |
| Timestamps / decimals | `TEXT` (`REAL` would be lossy for decimals) | `timestamptz` / `numeric` |
| Write locking | WAL + a single-writer queue | advisory locks |

`lock` rows exist in both (Umbraco's `SqliteDistributedLockingMechanism` takes a
row lock per `Constants.Locks` id); they are the named-lock registry the lock
abstraction uses.

## Migrations

Umbraco tracks state as **a single GUID in `key_value`**, not a version number and
not a list of applied migrations: key
`Umbraco.Core.Upgrader.State+Umbraco.Core`, value = current state GUID. The plan
is a chain of `From(state) → To<Migration>(nextState)` transitions walked forward
to `FinalState`, each in a transaction, with branch/merge support. A fresh install
stamps the **final** state so no migrations then run.

We copy this design — it handles concurrent development branches far better than
sequence numbers — with our own initial GUID, and harden it with a ledger,
`--plan`, and enforced expand/contract (`10-packaging-and-upgrades.md`). Value
migrations are a separate step, gated on a pre-upgrade check that proves and
prepares the data before anything irreversible is written.

`DatabaseSchemaCreator._orderedTables` is a hand-maintained, FK-safe, 74-entry
creation order beginning `UserDto, NodeDto, ContentTypeDto, TemplateDto,
ContentDto, ContentVersionDto, MediaVersionDto, DocumentDto, ElementDto,
ContentTypeTemplateDto, DataTypeDto, …`. **Use that ordering verbatim for
migration 0.** Umbraco also derives DDL from the DTOs and offers a
`ValidateSchema()` self-check comparing live tables/columns/indexes against the
definitions — a pattern worth porting.

Seed data (`DatabaseDataCreator.cs`) creates: the `-1` root and `-20/-21/-22`
recycle bins, the `-92` label data type, one `lock` row per named lock, the admin
user (id 0), six built-in user groups (identity seeded at 6), their section and
permission rows, default data types, relation types, the `en-US` language
(identity seeded at 2), and the `key_value` migration stamp.

## Build order

**Tier 1 — the floor** for page edit + versioning + templates + users:
`node`, `content`, `content_version` (events), `document`, `document_version`,
`property_value`, `schema_state`, `content_type`, `property_type`,
`property_type_group`, `data_type` (without it you cannot decode a value),
`template`, `user_account`, `user_group` + `user_group_member`, `key_value`.

**Tier 2 — a credible CMS (+8):** `content_type_allowed_child`,
`content_type_template`, `content_type_composition`, `user_group_permission`,
`user_group_granular_permission`, `user_start_node`, `language`, `lock`.

**Tier 3 — members (+3, +2):** `member`, `member_property_type`,
`member_group_member`, then `external_login` + `external_login_token`.

**Tier 4 — multilingual (+3):** `content_version_culture_variation`,
`document_culture_variation`, `domain`.

**Deferred as pure optimisation:** `content_cache` (read through the canonical
join below instead), `document_url`/`document_url_alias` (walk the tree), and the
entire load-balancing set (`cache_instruction`, `server`, `last_synced`,
`repository_cache_version`, `distributed_job`) — a single Bun process needs none.

### The canonical "read a document" query

The draft is the set of `is_current` values; the published document is the
latest value per key at or before the published event:

```sql
-- draft
SELECT pv.* FROM property_value pv
WHERE pv.node_id = ? AND pv.is_current = true

-- published, as the published cache reads it
SELECT pv.* FROM property_value pv
JOIN (
  SELECT property_type_id, language_id, segment, MAX(id) AS id
  FROM property_value
  WHERE node_id = ? AND event_id <= (published event id)
  GROUP BY property_type_id, language_id, segment
) latest ON latest.id = pv.id
```

An older node adds `AND schema_state_id <= (its own state)` to the inner query
and reads exactly what was there for its version. The index that carries all
three is `(node_id, property_type_id, language_id, segment, id DESC)`.

## Columns added in 5b

- `data_type.alias` — schema files reference a data type by alias; Umbraco has
  only a key and a name. Seeded for the built-ins; derived from the name on
  export for types created in the backoffice.
- `schema_state.hash` is rewritten after key write-back and after a backoffice
  save writes a file, so it always describes the files as they now are.
- `server` and `cache_instruction` are live: every node upserts its row at boot
  and on each poll; sync, publish and unpublish append instructions.

## Tables and columns added in 5c

- `migration_history(name, kind, from_state, to_state, applied_at, duration_ms,
  checksum, applied_by, note)` — the ledger: every framework step (`expand`,
  `contract`), every value migration and converter run (`value`), every
  cut-over (`upgrade`) and purge (`contract`).
- `since_version` on `content_type`, `property_type`, `data_type` — the
  file's explicit `since`, beside `since_state_id`.
- `change_report(run_id, source, scope, kind, code, subject_type, subject_key,
  subject_name, property_alias, culture, message, link, status, first_seen,
  last_seen, resolved_at)` — findings, upserted by
  `(code, subject, property, culture)` within their own `(source, scope)`; a
  stable shape the dashboard reads. Named `upgrade_report` until migration 018:
  the pre-upgrade check and content transfer share it, and because a run
  resolves whatever it no longer reports, `source` (`upgrade` | `transfer`) and
  `scope` (a bundle id, or null) are what keep one run's sweep out of another's
  findings.
- `schema_state.status = 'prepared'` is now written by `check --fix`; the
  cut-over marks that row `current` rather than appending a new one.

## Data added in Phase 6

- `document.original_parent_id` (migration 006) — where a trashed document
  came from.
- `user_group_permission` rows for the built-in groups (seed, and migration
  007 for older databases) — Umbraco's installer verbs, verbatim.
- `member_property_type` (migration 008) and the rich text editor UI fix
  (migration 009).
- **Migration 010, WP-6.5:** `content_schedule(node_id, language_id, action
  'Release' | 'Expire', date)` for scheduled publishing, claimed with
  `DELETE … RETURNING` so a schedule runs once across nodes;
  `user_notification(user_id, node_id, action)` for notification
  subscriptions; `domain(node_id, language_id, domain_name, sort_order)` for
  culture and hostnames, names unique (the wildcard is `*<node id>`).
- **Media and blueprints are documents** of their own object types. The
  document repository takes a `kind` (document, media, blueprint), which picks
  the object type, the recycle bin and the folder type; media and blueprints
  are never published. The `document` and `document_version` rows they carry
  hold versions, not publishing.
- **Version cleanup** follows the rule above: kept are the current draft, the
  published version, pinned versions, everything newer than keep-all days,
  and each day's latest for keep-latest days; a pruned version's value row
  that a kept version still reads is re-pointed at the earliest kept version
  after it, so every kept version reads what it did.
- **Tags** have no table: they are read from the current values of Tags
  properties.
- **Migration 011, WP-6.6 and 6.7:** `user_group_language(user_group_id,
  language_id)` for the languages a group may work in; `user_data(key, user_id,
  data_group, identifier, value)` for the backoffice's per-user settings;
  `user_token(token_hash, user_id, purpose, expires_at)` for single-use
  invitation and reset links, stored hashed; `user_client_credential(client_id,
  user_id, secret_hash)` for API users; `dictionary_item(key, parent_key,
  item_key)` and `dictionary_text(dictionary_key, language_id, value)` (Umbraco's
  `cmsDictionary`/`cmsLanguageText`); and on `document_culture_variation`,
  `published_event_id` and `published_name` — the publish each culture went
  live with and its name then, so each culture's published values are read as
  of its own publish. It renames `user_account.is_disabled` to `is_locked_out`
  (a disabled user is one not approved, as in Umbraco) and moves Postgres'
  `user_group` identity past the built-in groups' explicit ids.
- The built-in groups and the super user seed with Umbraco's keys, so a fresh
  database names them as Umbraco does.
- **Migration 012:** `log_viewer_query(id, name, query)`, the log viewer's saved
  searches (Umbraco's `umbracoLogViewerQuery`), seeded with Umbraco's; a name is
  matched exactly, case and all.
- **Migration 013, WP-6.8:** `member` (Umbraco's `cmsMember` snake-cased, with the
  password columns nullable because a member who only ever signs in through a
  provider has none), `member_group_member` (`cmsMember2MemberGroup`),
  `external_login` and `external_login_token`. A member is a node facet exactly
  like a document, so the document repository gained a fourth `kind`: member,
  whose object type is Member, with no recycle bin and no folder type, because
  members are a flat list at the tree root.
- **Migration 014, WP-6.8:** `public_access(key, node_id, login_node_id,
  error_node_id, …)` and `public_access_rule(public_access_id, rule_type,
  rule_value)` — Umbraco's `umbracoAccess` and `umbracoAccessRule`. The rules are
  **values, not foreign keys**: a member group's *name* or a member's *username*,
  as Umbraco stores them, because a rule is evaluated against what a signed-in
  member carries. Renaming the group is therefore what breaks the rule, not
  deleting a row — which is the behaviour Umbraco has, and the reason not to
  "improve" it into a foreign key.
- **Migration 015, WP-6.9:** `redirect_url` — Umbraco's `umbracoRedirectUrl`,
  widened for redirects a site declares in code rather than earns by being
  renamed. Umbraco's row is always an exact route pointing at a document; ours
  carries `match_kind` (`exact` | `prefix` | `regex`), `target_kind`
  (`document` | `path` | `url`), a `status_code`, a `sort_order` for the order
  configured rules are matched in, and `source` (`tracked` | `config`) so the API
  can refuse to delete a rule the config file owns. `root_key` scopes a rule to the
  document a hostname roots — Umbraco scopes by the domain's node id for the same
  reason, so that renaming the hostname leaves every redirect below it working.
  `match_hash` is a digest of everything the rule matches on, uniquely indexed: a
  unique index cannot dedupe over nullable columns, and a pattern is too long to
  index directly. Umbraco hashes its URL for both reasons. The effect of that index
  is that re-registering a route **replaces** where it points rather than stacking a
  row behind it, which gives Umbraco's "most recent wins" without the duplicates.
- **Migration 016, WP-6.11:** no table at all. An element is a node facet exactly
  as a document is — `node` + `content` + `content_version` — so the document
  repository takes `element` as a fifth `kind` and versioning, publishing, copy,
  move and the recycle bin are machinery that already existed. Its folders are
  `node` rows with the ElementContainer object type, which is why they worked
  before elements did. The migration adds one row: the Elements recycle bin at
  `-22`, with Umbraco's own id and object type
  (`Constants.System.RecycleBinElement`), so a database here numbers its bins as
  Umbraco's does.

  Two things about that one row were worth the trouble. It is a single guarded
  `INSERT … SELECT … FROM node … WHERE NOT EXISTS … LIMIT 1` rather than a read
  followed by an insert, because `bunbraco upgrade --plan` runs every migration
  against a recorder whose `query` refuses to read — a migration that reads cannot
  be planned. And `FROM node` is load-bearing: a fresh database is seeded *after*
  migrations run, and `seedContent` only seeds while `node` is empty, so an
  unconditional insert here suppressed the entire seed, data types included, and
  left every content type unresolvable. The suite caught it as 40 failures.
- **No member session table.** A signed-in member carries a signed ticket in a
  cookie, naming the member, its expiry and the security stamp it was issued
  against; the stamp is checked on every request, so a password change or a
  lockout ends every session that member had. The signing key is a `key_value`
  row generated on first use, so every node in a load-balanced set agrees on it.
  Nothing per-session is stored.
- **Media bytes are not necessarily on disk.** Where they live is the
  `MediaStore` seam (file system, S3, Azure); the database holds only the path a
  value names, exactly as before, so moving the store moves no data model.

