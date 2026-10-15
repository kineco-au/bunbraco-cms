# 071 — Import members, users, redirects, protected pages and schedules

**Epic:** H — Importing an Umbraco site · **Priority:** should · **Size:** L
**Depends on:** 070

## Story

As someone moving an Umbraco site, I want its members, users, redirects,
protected pages and scheduled publishing to come across with it, so that nobody
has to reset a password and nothing about how the site behaves is lost.

## Context

070 imports schema, content and views. The report counts these and does not
import them. [`umbraco-import.md`](../../umbraco-import.md), "Where it stands",
records WP-I.5 (site data) as partly built: dictionary and hostnames are
written as files.

- **Members and users.** Umbraco stores ASP.NET Core Identity v3 hashes
  (PBKDF2-HMAC-SHA512). Crombolo stores argon2id, and records the algorithm per
  row in `password_config`. The plan:
  1. Carry the original hash with its algorithm marker.
  2. Teach `verifyPassword` to verify PBKDF2.
  3. Re-hash to argon2id on a successful sign-in. That is the rotation the
     column was kept for, so nobody is forced to reset.

  A bundle carried no members; the decision below gives it an encrypted
  section for them instead.
- **Redirects, protected pages, schedules.** No file format carries them yet.

## Acceptance criteria

- [x] Members and backoffice users import with their groups, keeping their
      Umbraco password hash with its algorithm marker.
- [x] `verifyPassword` verifies the PBKDF2 hash, and a successful sign-in
      re-hashes to argon2id.
- [x] Members and users travel only in the bundle's encrypted `people/`
      section (see the decision below), never in the open, and a bundle with
      one cannot be installed from the marketplace or published.
- [x] A bundle's metadata is readable and anything that can hold personal
      information is sealed: property values, media files and protected-page
      usernames. `content export` leaves values out unless
      `--include-content`; `--allow-content-unencrypted` writes them in the
      open with a warning.
- [x] Redirects import as rules matching 042's model.
- [x] Protected pages import with their member-group rules.
- [x] Scheduled publish and expire dates import as schedules.
- [x] The compatibility report moves each of these from *not imported by this
      version* to imported, with counts.
- [x] The demo store fixture proves each. Where it has none of a kind, an altered
      fixture does.

## Out of scope

- External and two-factor logins (032), which stay counted and not imported.
- Webhooks (044).
- Razor → TSX conversion offered by the assistant (130).

## Decision (2026-10-15)

Asked for: an option to export bundles that include members, encrypted. This
replaces "a bundle carries no members" above.

- **An encrypted `people/` section in the bundle**: member groups, members,
  user groups and users. Optional, and present only when asked for.
- **A passphrase per export**, from `CROMBOLO_BUNDLE_PASSPHRASE` or a prompt,
  stretched with scrypt and a random salt kept in the bundle. Each file is
  sealed with AES-256-GCM under the derived key. The manifest records counts
  only — never a name or an e-mail address.
- **All four password formats Umbraco accepts** are verified — ASP.NET Identity
  v3 and v2 (PBKDF2), Umbraco 8's HMAC-SHA256 and Umbraco 4's HMAC-SHA1 — and a
  successful sign-in re-hashes to argon2id, so nobody resets a password.
- **Conflicts**: the same key is the same person, updated, keeping a password
  set here since. A different key whose e-mail or user name is taken here is a
  `person` finding (skip, or take the incoming), answered like content
  conflicts. The dry run names people by key only.

## Decision: what is sealed (2026-10-15)

Raised during the work: personal information is not only in members — a
document property can hold it too. The split is metadata in the open,
anything that can hold personal information sealed, under one passphrase per
export:

| Open | Sealed |
|---|---|
| The manifest, with the seal's salt and cost | Property values |
| Each node's key, kind, type, parent, order, template | Media file contents |
| Names of pages and media, cultures, published flags | Usernames on protected-page rules |
| Each value's property, culture, editor and references | `people/` |
| Schema, components, styles, scripts, dictionary | |
| Redirects, schedules, protected pages by member group | |

- **`content export`** leaves property values and media files out unless
  `--include-content`. A bundle without them places and names pages and
  writes no value.
- **`--include-content`** seals them; the passphrase comes from
  `CROMBOLO_BUNDLE_PASSPHRASE` or a prompt.
- **`--allow-content-unencrypted`** (with `--include-content`) writes them in
  the open and prints a warning. People are never written in the open.
- **The Umbraco import takes the same flags**: without `--include-content`
  it brings schema, views, the tree with names, templates, redirects,
  schedules and protected pages by group, and no value or media file — and
  its output and report say so and name the flag. People are opted into
  separately (`--with-members`, `--with-users`) and always sealed.
- **A publishable package** (created in the backoffice, or `bundle publish`)
  is open: what it carries is meant for anyone who installs it, and it is
  refused if it carries people or sealed content.
- **The check needs the passphrase** to compare values; without it, a sealed
  bundle is a blocking finding that asks for one. The Packages dashboard asks
  for it, uses it for that request only, and never stores it.

## Plan

1. **Passwords** (`packages/auth`): pure verifiers for the four formats, from
   Umbraco's `PasswordHasher`/`LegacyPasswordSecurity`, each with test vectors
   (the demo store's admin hash is Identity v3, SHA-512, 100,000 iterations);
   `verifyPassword(password, hash, config)` dispatching on `password_config`;
   re-hash to argon2id on success at the five verify sites, users and members.
   Users' `password_config` starts being read.
2. **Sealing** (`packages/transfer`): `sealFile` / `openFile` — scrypt
   (N=2^17, r=8, p=1) over the passphrase with a 16-byte salt, AES-256-GCM per
   file with a random nonce, the file's path as additional data so files
   cannot be swapped. Pure functions with injected randomness for tests.
3. **The bundle section**: `people` in `BUNDLE_SECTIONS`, format version 3;
   carried files read and hashed as bytes; the manifest's `people` block holds
   the salt, KDF parameters and counts. An older reader refuses version 3 by
   name rather than mis-hashing it. `bundle install`, the marketplace and
   `writeBundlePackage` for a publishable package refuse a bundle with people.
4. **Reading Umbraco's people** (`packages/import-umbraco`): stage
   `umbracoUser2UserGroup`, `umbracoUserGroup2App`, `umbracoUserGroup2Permission`,
   `umbracoUserGroup2Node` (granular), `umbracoUserGroup2Language`,
   `umbracoUserStartNode`; convert members (with their member type, groups and
   property values), member groups, users and user groups into the section,
   their hashes kept with their algorithm marker. `crombolo import umbraco
   apply --with-people` seals it.
5. **Applying** (`packages/server`): the check reads the sealed section with
   the passphrase, plans each person (create / update / conflict) by key, and
   reports by key; the import writes them in the content run's transaction and
   records them on the run, so a revert removes the people it created.
6. **crombolo to crombolo**: `content export --with-members` (members and
   member groups; users stay out unless `--with-users`), sealed the same way.
7. **Redirects, protected pages, schedules** (no secrets, so in the open
   bundle): `redirects/`, `access/`, `schedules/` sections — Umbraco's
   `umbracoRedirectUrl` as `tracked` rules matching 042's model,
   `umbracoAccess`/`umbracoAccessRule` as public access entries by group name,
   `umbracoContentSchedule` as `setSchedule` calls — applied after the content
   they name.
8. **Report**: each row moves from *not imported* to imported, with counts;
   external and two-factor logins stay counted, not imported (032).
9. **Fixture and tests**: an altered copy of the demo store (as
   `tests/import-umbraco.test.ts` already makes) with members in groups,
   a redirect, a protected page and a schedule, one member per hash format;
   round-trips through export, seal, check, import and sign-in, a wrong
   passphrase refused, a tampered file refused, and a revert.
10. **Docs**: `docs/umbraco-import.md`, `docs/content-transfer.md` ("People"),
    `docs/bundles.md` (the section and its refusals).

Migrations: none expected — members, users, schedules, redirects and access
already have their tables; a run's people are recorded with its changes.

## Implementation

- **Passwords** — `packages/auth/src/umbraco-passwords.ts`: ASP.NET Identity v3
  and v2, Umbraco 8's HMAC-SHA256/SHA1 and Umbraco 4's HMAC-SHA1, verified
  against Umbraco's own vectors; `verifyPassword` falls back to them for a hash
  that is not argon2id, and user and member sign-in re-hash on success.
- **Sealing** — `packages/transfer/src/seal.ts`: one seal per export (scrypt,
  AES-256-GCM per file, the path as additional data, a check value).
  `writeBundle(set, blobs, sections, { content, seal, people })` writes
  `values/<key>.json` and sealed `blobs/` for `sealed`, nothing for `omitted`;
  `openBundle(loaded, passphrase)` opens them. Format 3 for anything sealed or a
  node carrying rules. A public package refuses people and sealed content.
- **Rules on a node** — `access`, `schedule`, `redirects` on `BundleNode`,
  exported by `exportBundle`, read from Umbraco's `umbracoAccess`,
  `umbracoContentSchedule` and `umbracoRedirectUrl`, applied by `importBundle`
  after every node exists.
- **People** — `packages/transfer/src/people-apply.ts`: `planPeople` (by key;
  `person-conflict` for an e-mail or username taken by another key),
  `applyPeople` (in the content run's transaction, recorded on the run),
  `removePerson` for a revert, `exportPeople` for `--with-members` /
  `--with-users`. `packages/import-umbraco/src/people.ts` reads Umbraco's.
  On the first boot of a new database the seeded administrator is taken over
  by an imported user with the same key, login or e-mail (`adoptUsers`).
- **Commands** — `content export` and `import umbraco apply` take
  `--include-content`, `--allow-content-unencrypted` (with a warning),
  `--with-members` and `--with-users`; the passphrase is prompted for without
  echo or read from `CROMBOLO_BUNDLE_PASSPHRASE`; `content check`, `content
  import` and `start --bundle` ask for it only when a bundle is sealed. The
  Changes dashboard asks for it and sends it per request.
- **Report** — members, users, protected pages, redirects and schedules move to
  *migrates* with counts; what was not asked for is *left behind* with the flag
  that brings it.
- **Tests** — `umbraco-passwords`, `umbraco-password-signin`, `bundle-seal`,
  `bundle-people` (sealed, omitted and open content; package refusals),
  `people-transfer` (crombolo to crombolo, conflicts, kept passwords),
  `import-umbraco-people` (an altered demo store: a member per hash format, a
  protected page, a redirect, a schedule; sign-in; revert), `content-export`
  (rules exported), `transfer-dashboard` (encrypted import from the dashboard),
  and both integration suites driving the CLI with sealed bundles.
- **Docs** — `content-transfer.md` ("What is readable, and what is sealed",
  "Pages' rules", "People"), `umbraco-import.md`, `bundles.md`.
- **Also fixed** — the boot check flagged built-in media and member types (and
  file-defined ones) as removed whenever the schema store had any file; it now
  checks each kind against its own files and skips the shipped types
  (`packages/schema/src/check.ts`, `tests/upgrade.test.ts`).

### Limits

- A revert removes the people a run created; those it updated keep the
  bundle's details. Protected-page rules, schedules and redirects on a page the
  run updated are not put back.
- A user group that already exists here keeps its permissions; only its
  members are added.
