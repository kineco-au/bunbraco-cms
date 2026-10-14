# 003 — Auth

**Epic:** A — Foundations · **Priority:** must · **Size:** L
**Depends on:** 002

## Story

As an editor, I want to sign in to the backoffice and stay signed in across a
reload and a second tab, so that I can work in it like the Umbraco I know.

## Context

The backoffice speaks OAuth2 authorization code with PKCE, and its login SPA
is not published to npm (R2 in [`../../roadmap.md`](../../roadmap.md)), so the
server provides both the authorization server and its own login page against
the same `…/security/back-office/*` endpoints.

The token semantics have to match Umbraco's exactly. The client must never be
made to call `validateToken()` per request: that revokes the previous
reference token and the UI logs itself out at random (R5).

**Scope decision:** user and user-group *administration* (53 operations) was
deferred, because none of it is needed to sign in. It was built in 026.

## Acceptance criteria

- [x] OAuth2 authorization code + PKCE server.
- [x] Reference tokens in `__Host-` cookies, with redaction.
- [x] Our own login page against `…/security/back-office/*`.
- [x] Permissions evaluated on every Management API call.
- [x] A real login, and the session survives a reload and a second tab.
- [ ] ~~User and user-group CRUD.~~ **Deferred to 026**, by agreement.
- [ ] ~~Two-factor sign-in.~~ **Not built.** The endpoint exists and answers
      definitively; the 402 path in the login UI is wired but unreachable.
      Carried by 032.

## As built

- The identity schema, with Umbraco's five seeded groups and their section
  grants.
- argon2id password hashing behind the `password_config` marker column, and
  timing-normalised login.
- The authorization-code + PKCE flow; single-use authorization codes.
- Reference tokens stored hashed; refresh-token rotation with reuse detection
  that kills the session.
- Contract-driven authorisation on every request.
- The login page is built from the UUI components the npm package does ship,
  so R2 cost no Node toolchain.
