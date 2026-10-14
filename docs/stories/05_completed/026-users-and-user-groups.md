# 026 — Users and user groups

**Epic:** C — The backoffice, end to end · **Priority:** must · **Size:** L
**Depends on:** 020

## Story

As a site administrator, I want to create users, put them in groups with
sections, start nodes and permissions, and have those limits enforced on
every call, so that an editor in a restricted group sees only their part of
the site and can do only what their group allows.

## Context

Epic framing and shared decisions are in 020. This story covers `user` (41
operations) and `user-group` (8 operations):

- CRUD and invitations, which degrade gracefully without e-mail
- enable, disable and unlock
- avatars and `user-data`
- permissions and start nodes, **enforced** on every Management API call
- the two-factor (MFA) endpoints, answering honestly

**Behaviour comes from Umbraco's code.** Permission and start-node behaviour
follows Umbraco's own rules and is not reinvented. The sections each area
demands come from Umbraco's controller policies. Verbs are calculated per
group as Umbraco calculates them. Start nodes combine as Umbraco's
`CombineStartNodes` does.

## Acceptance criteria

- [x] `user` (41 operations) and `user-group` (8 operations): CRUD, invite
      (degrading without e-mail), enable, disable, unlock, avatar and
      `user-data`.
- [x] Permissions and start nodes are enforced on every Management API call.
- [x] The MFA endpoints answer honestly that no provider is installed. A real
      second factor is 032.
- [x] **Exit.** An editor in a restricted group sees only their start node and
      cannot delete.
- [ ] Login providers. They answered empty until members were built (030).
      External providers are 031.

## As built

### Enforcement on every call

`api-management/src/authorization.ts` runs before any handler.

- **Sections first.** It checks the sections each area demands, from
  Umbraco's controller policies. A writer reaches content and reads content
  types but cannot change them. Users need the Users section, and the
  dictionary needs Translation.
- **Then per-node rules for documents.** Each operation needs its verb on the
  node it names: Create on the parent, Move and Create on the target, Publish
  on the branch, Delete on the bin, and so on. It also needs path access below
  the caller's start nodes, and the languages a group may publish.
- **Verbs are calculated as Umbraco does.** For each group, the nearest node
  on the path that the group sets explicitly replaces its defaults, and an
  empty set denies. The result is unioned over the user's groups.
- **Start nodes** combine as Umbraco's `CombineStartNodes` does. Media checks
  path access.
- **A refusal is a bare 403.** Administrators are not exempt, as in Umbraco;
  their group simply holds every permission.

### Trees for restricted users

- The root shows the way to each start node (`noAccess`).
- Below an unreachable node, children show only the way on.
- The recycle bins are empty without root access.

### Users

- **Listing.** List and filter by text, groups and states, with ordering, and
  batch reads.
- **Validation.** CRUD uses Umbraco's validation: the username is the e-mail,
  duplicates are refused, and a group is required.
- **States** are derived as Umbraco does: `Invited`, `LockedOut`, `Disabled`,
  `Inactive` and `Active`.
- **Account actions.**
  - Disable, enable and unlock.
  - Delete, but only for users who have never signed in.
  - Set groups.
  - Change password; changing your own needs the old one.
  - Reset password, which generates a password that Create shows once.
- **Avatars.** Five crop sizes, served by the imaging route.
- **Calculated start nodes.**
- **API users.** Client credentials, with the `client_credentials` grant.
- **Who sees whom.**
  - Only admins see or touch admins, and the super user is hidden from
    everyone else.
  - A non-admin may hand out only groups they hold and start nodes they
    reach.

### User groups

- **Contents.** CRUD with sections, languages, start nodes, default verbs and
  granular permissions. Granular permissions cover document, property-value
  and unknown contexts, stored as Umbraco stores them.
- **Members.** Members are added and removed.
- **Protected groups.** System groups keep their alias and cannot be deleted,
  and the admin group is never emptied.
- **Non-admins** see and edit only their own groups, and join any group they
  create.
- **Seeded keys.** Built-in groups and the super user seed with Umbraco's
  keys.

### Other endpoints

- User data per user.
- The current user: permissions per node, profile language and
  configuration.
- Two-factor, answering that no provider is installed.
- Login providers, empty until 030.

### Invitations and resets without e-mail

- With no `sendUserLink`, `canInviteUsers` is false and Invite answers
  Umbraco's `CannotInvite`.
- With one (in development, the console), the link lands on our login page.
  The page verifies the token, sets the first password, and offers
  "Forgotten password?" when `allowPasswordReset` is on.
- `user_account.is_disabled` is renamed `is_locked_out`, which is what it
  meant.

### Tests

- `tests/users.test.ts` and `tests/authorization.test.ts`, on both dialects.
- In the real backoffice:
  - `tests/browser/users.browser.ts`: a user is created in the Users section,
    their group is opened and saved, and that editor sees only their branch
    with no Delete offered.
  - `tests/browser/login.browser.ts`: an invitation is accepted and a
    forgotten password is reset on the login page.

API coverage 339/513.

## Out of scope

- Sending e-mail: 045.
- A real second factor: 032.
