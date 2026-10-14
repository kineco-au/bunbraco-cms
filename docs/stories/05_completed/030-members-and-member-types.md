# 030 — Members and member types

**Epic:** D — Members and identity · **Priority:** must · **Size:** L
**Depends on:** 023, 026

## Story

As a site developer, I want members with types, groups and front-end sign-in,
and pages protected by member group. As an editor, I want to manage those
members in the backoffice. Together, a site can have a members' area that
only the right people can see.

## Context

This is the built part of WP-6.8, "Members, federated". External identity
providers (OIDC and OAuth, linked to local members with auto-linking) were
part of the same package. They are **carved out to 031**, which carries that
package's original exit criterion: *a page protected by a member group is
served only after signing in through an external provider*.

**Member types are files.** They follow the epic-wide decision in 020:
`schema/member-types/*.toml`.

**A member is stored like a document.** A member is a node facet exactly like
a document, so member types, properties and versioning reuse machinery that
already existed ([`../../data-model.md`](../../data-model.md)). The
`external_login` table is polymorphic, so federation built for members also
serves backoffice users.

**Front-end sign-in uses endpoints of our own.** Umbraco has no fixed URLs
for front-end sign-in; a site writes a surface controller. Four endpoints are
ours, under the fixed `/umbraco` namespace rather than the movable backoffice
path, because they belong to the framework and not to the editor.

**A session is a signed ticket in a cookie**, not a server-side session row.
Nothing is stored, which suits a load-balanced set. The ticket carries the
member's security stamp, and the stamp is checked on every request, so a
password change or a lockout ends every session that member had, immediately.
That is how ASP.NET Identity's security stamp works, without the framework.
The ticket is signed and deliberately not encrypted: it carries no secret,
and tampering is the only threat.

**Two decisions worth stating:**

- **Registration is off by default.** An endpoint that creates accounts is a
  decision a site makes, not one a framework makes for it. When it is on, it
  takes a member type alias and default group names from config.
- **A `returnUrl` must be a local path.** An absolute or protocol-relative one
  is ignored, which closes the open redirect a login form would otherwise be.

**Access rules name groups and members by value.** Public access rules are
values (a member group's name, or a member's username), not foreign keys, as
Umbraco stores them. A rule is evaluated against what a signed-in member
carries, so renaming a group is what breaks a rule, not deleting a row.

## Acceptance criteria

- [x] **Member types** as `schema/member-types/*.toml` under
      `[member-type]`, with folders and the member-only property keys.
- [x] **The member store**, with member groups and `external_login` ready for
      providers.
- [x] **Member groups**: all seven operations the contract declares.
- [x] **Members**: the remaining ten operations: the editor, the Members
      collection and the picker lookups.
- [x] Umbraco's default "Member" type ships as a system type.
- [x] **Front-end sign-in**: login, logout, registration and the current
      member.
- [x] **Public access** is stored and enforced as Umbraco does. Story 024
      left it to this story.
- [x] Templates receive the signed-in member.
- [ ] External identity providers. **Carved out to 031**, with this package's
      original exit criterion.
- [ ] A second factor for members: 032. `isTwoFactorEnabled` reports false
      honestly until then.

## As built

### Member types

- **Storage.** Member types follow media types: the same table, told apart by
  node object type, with `MemberTypeContainer` added for their folders.
- **File shape.** `schema/member-types/*.toml` under `[member-type]` has no
  templates, cleanup or allowed children.
- **Member-only keys.** Three property keys only member types accept:
  `member-can-view`, `member-can-edit` and `sensitive`. They are stored in
  `member_property_type` (migration 008; Umbraco's `cmsMemberType`).
- **Found on the way.** A property removed in the backoffice and re-added
  under the same alias (and so a new key) broke the save on the unique index.
  The repository now reuses that row, retired or live, so its values come
  back. That is the design's revival rule, which the file sync already
  followed.
- Pinned by `tests/member-types.test.ts`.

### The store (migration 013)

- **Shape.** A member is `node` + `content` + `content_version` + `member`.
  The columns are Umbraco's `cmsMember`, snake-cased.
- **Optional passwords.** The password columns are nullable, because a member
  who only ever signs in through a provider has none.
- **Member groups** are plain `node` rows with the MemberGroup object type,
  joined to members by `member_group_member`.
- **External logins.** `external_login` is polymorphic on
  `user_or_member_key`, as Umbraco's is. `external_login_token` holds
  per-login tokens.

### Member groups

- All seven operations: CRUD, the item lookup that pickers use, and a flat
  tree root.
- No children, ancestors or siblings operation exists, because a member group
  never has any.
- A name already taken is a 400 `DuplicateName`. Renaming a group to the name
  it already has is not.
- Pinned by `tests/member-groups.test.ts`.

### Members

- **The editor.** `GET`, `POST`, `PUT` and `DELETE`, plus both validate
  calls.
- **The Members collection.** `filter/member` is Umbraco's own member filter,
  with the same columns and the same default order (username ascending).
- **Picker lookups.** The three lookups a member picker makes.
- **Not a tree.** The contract declares no `tree/member` operations, and
  `item/member/ancestors` answers an empty list per id, because a member
  never has ancestors.

Three rules live in the adapter rather than the repository, because each is a
policy and not a fact about storage:

- **Uniqueness.** A duplicate username or e-mail is a 400. The columns are
  case-insensitive in both dialects, so `A@b.com` clashes with `a@b.com`.
- **Sensitive values.** A member property marked `sensitive` is withheld from
  a user outside the Sensitive data group, following compositions. The seeded
  administrator is in that group, as Umbraco's installer puts it, so the
  editor sees everything by default.
- **Passwords.** Plaintext reaches the adapter and no layer below it. A
  password change rotates the security stamp.

**Fixed reported values.**

- `kind` is always `Default`. Umbraco reports `Api` only for a Delivery API
  client-credentials member (050), and `ExternalOnly` only for a member in its
  lightweight external-member table. We have neither.
- `isTwoFactorEnabled` is always false, because no second factor is offered
  yet. That reports the truth rather than storing a flag nothing enforces.

### The default "Member" type

It ships as a *system* type, like the Folder, Image and File media types:

- alias `Member`, with no properties
- ensured at every boot, and exempt from schema retirement

Since Umbraco 18 the standard property stubs are empty, and everything a
member always has is a column. Without this type, a fresh install could not
create a member until someone wrote a TOML file, which Umbraco does not
require.

### Front-end sign-in

- **Endpoints.** `POST /umbraco/members/{login,logout,register}` and
  `GET /umbraco/members/current`.
- **Form or fetch.** A form post is answered with a redirect, and a JSON post
  with JSON. One endpoint therefore serves both a plain `<form>` in a template
  and a `fetch` from the page.
- **The ticket.** The cookie ticket names the member, its expiry and the
  security stamp it was issued against. It is signed with HMAC-SHA256 over a
  key generated once into `key_value`, and so shared by every node.

### Public access (migration 014)

- **Tables.** Umbraco's `umbracoAccess` and `umbracoAccessRule`,
  snake-cased.
- **Reading back.** Reading an entry back resolves each name to the member or
  group the editor should see. A name that no longer resolves simply drops
  out, which is exactly what a rename means.
- **Enforcement is Umbraco's.** A protected page is **rewritten** to its login
  or error page rather than redirected, so the visitor keeps the URL they
  asked for.
- **Governing rule.** The nearest protected ancestor governs, resolved
  against `node.path` rather than by walking parents.
- **Login and error pages** render even when they sit inside the branch they
  serve. Without that exception the substitution would not terminate. The
  renderer caps substitutions at 8, as Umbraco does.
- **Refused rules.** A rule naming both groups and members is refused as
  ambiguous, and one naming neither as empty. Both are Umbraco's own errors.
- **Preview is exempt**, since only a signed-in editor reaches it.
- **Templates** receive the member as a prop alongside the model, with
  `roles` as group *names*: the same currency the rules deal in.

### Tests

- `tests/members.test.ts` and `tests/public-access.test.ts`, on both
  dialects.
- The public-access tests assert the body served at a protected URL to an
  anonymous visitor, a signed-in outsider and a member of the group.

## Out of scope

- External identity providers, and the decided shape for them (typed presets
  `entra(...)`, `awsIdentityCenter(...)` and `oidc(...)`): 031.
- A second factor: 032.
- Provisioning from an identity provider (SCIM): 033.
